import type { Env } from './env';
import type { Heartbeat, Incident, Task } from './models';
import { nextOccurrence } from './cron';
import { HttpError } from './http';
import { escapeHtml, htmlResponse } from './html';
import { randomId } from './security';

export const HISTORY_RETENTION_DAYS = 90;
type ScanEventKind = 'scan_opened_missed' | 'scan_reminder' | 'scan_error' | 'rerun_unknown';
// Deliverable event kinds are reserved in the migration for the next unit.
export async function recordScanEvent(env: Env, now: Date, taskId: string, kind: ScanEventKind, refId: string | null = null, detail: string | null = null): Promise<void> {
  try {
    await env.DB.prepare('INSERT INTO scan_events (id,task_id,at,kind,ref_id,detail) VALUES (?,?,?,?,?,?)')
      .bind(randomId('evt_'), taskId, now.toISOString(), kind, refId, detail).run();
  } catch (error) { console.error('Scan event insert failed', error instanceof Error ? error.message : 'Unknown error'); }
}

export async function pruneHistory(env: Env, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - HISTORY_RETENTION_DAYS * 86400000).toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM heartbeats WHERE received_at < ?').bind(cutoff),
    env.DB.prepare('DELETE FROM scan_events WHERE at < ?').bind(cutoff),
    env.DB.prepare('DELETE FROM incidents WHERE resolved_at IS NOT NULL AND resolved_at < ?').bind(cutoff),
  ]);
}

async function getTask(env: Env, id: string): Promise<Task> {
  const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first<Task>();
  if (!task) throw new HttpError(404, 'not_found', 'Task not found');
  return task;
}

export async function taskRuns(request: Request, env: Env, id: string): Promise<Response> {
  await getTask(env, id);
  const params = new URL(request.url).searchParams;
  const rawLimit = Number(params.get('limit') ?? 50);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, Math.trunc(rawLimit))) : 50;
  const before = params.get('before');
  if (before !== null && (!/^\d{4}-\d{2}-\d{2}T/.test(before) || !Number.isFinite(Date.parse(before)))) {
    throw new HttpError(400, 'validation_error', 'before must be an ISO timestamp');
  }
  const { results: runs } = await env.DB.prepare(`SELECT * FROM heartbeats WHERE task_id = ? ${before !== null ? 'AND received_at < ?' : ''} ORDER BY received_at DESC, id DESC LIMIT ?`)
    .bind(id, ...(before !== null ? [new Date(before).toISOString()] : []), limit).all<Heartbeat>();
  const oldest = runs.at(-1)?.received_at ?? null;
  const newest = runs[0]?.received_at;
  const incidents = oldest && newest ? (await env.DB.prepare('SELECT * FROM incidents WHERE task_id = ? AND ((opened_at >= ? AND opened_at <= ?) OR (expected_at >= ? AND expected_at <= ?)) ORDER BY opened_at DESC, id DESC')
    .bind(id, oldest, newest, oldest, newest).all<Incident>()).results : [];
  return Response.json({ runs, next_before: oldest, incidents });
}

export async function scheduleTasks(env: Env, now: Date) {
  const [{ results: tasks }, { results: incidents }] = await Promise.all([
    env.DB.prepare('SELECT * FROM tasks').all<Task>(),
    env.DB.prepare('SELECT id,task_id,kind,expected_at,opened_at,alert_status FROM incidents WHERE resolved_at IS NULL ORDER BY opened_at DESC, id DESC').all<Pick<Incident, 'id' | 'task_id' | 'kind' | 'expected_at' | 'opened_at' | 'alert_status'>>(),
  ]);
  return tasks.map(task => ({
    id: task.id, name: task.name, schedule: task.schedule, timezone: task.timezone,
    grace_minutes: task.grace_minutes, paused: Boolean(task.paused), last_heartbeat_at: task.last_heartbeat_at,
    last_status: task.last_status, schedule_anchor_at: task.schedule_anchor_at, created_at: task.created_at,
    next_run: nextOccurrence(task.schedule, task.timezone, now)?.toISOString() ?? null,
    open_incidents: incidents.filter(incident => incident.task_id === task.id).map(({ task_id: _taskId, ...incident }) => incident),
  })).sort((a, b) => a.next_run === b.next_run ? a.name.localeCompare(b.name) : a.next_run === null ? 1 : b.next_run === null ? -1 : a.next_run.localeCompare(b.next_run));
}
const cell = (value: unknown) => `<td>${escapeHtml(String(value ?? '—'))}</td>`;
function table(headers: string[], rows: string[]): string {
  return `<table><thead><tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}
export async function scheduleHtml(env: Env): Promise<Response> {
  const tasks = await scheduleTasks(env, new Date());
  return htmlResponse('<h1>Schedule</h1>' + table(['Name', 'Schedule / timezone', 'Next run', 'Last heartbeat / status', 'Paused', 'Open incidents', 'History'], tasks.map(task =>
    `<tr>${cell(task.name)}${cell(`${task.schedule} / ${task.timezone}`)}${cell(task.next_run)}${cell(`${task.last_heartbeat_at ?? '—'} / ${task.last_status ?? '—'}`)}${cell(task.paused)}${cell(task.open_incidents.map(i => `${i.kind}: ${i.expected_at} (${i.alert_status})`).join('; '))}<td><a href="/admin/tasks/${escapeHtml(encodeURIComponent(task.id))}/history">History</a></td></tr>`)));
}
export async function historyHtml(env: Env, id: string): Promise<Response> {
  const task = await getTask(env, id);
  const [runs, open, recent] = await Promise.all([
    env.DB.prepare('SELECT * FROM heartbeats WHERE task_id = ? ORDER BY received_at DESC, id DESC LIMIT 100').bind(id).all<Heartbeat>(),
    env.DB.prepare('SELECT * FROM incidents WHERE task_id = ? AND resolved_at IS NULL ORDER BY opened_at DESC, id DESC').bind(id).all<Incident>(),
    env.DB.prepare('SELECT * FROM incidents WHERE task_id = ? AND resolved_at IS NOT NULL ORDER BY opened_at DESC, id DESC LIMIT 100').bind(id).all<Incident>(),
  ]);
  return htmlResponse(`<h1>${escapeHtml(task.name)}</h1><p>${escapeHtml(task.schedule)} / ${escapeHtml(task.timezone)}</p><h2>Recent heartbeats</h2>` +
    table(['Received', 'Status', 'Run ID', 'Output URL', 'Message'], runs.results.map(r => `<tr>${[r.received_at, r.status, r.run_id, r.output_url, r.message].map(cell).join('')}</tr>`)) +
    '<h2>Open and recent incidents</h2>' + table(['Kind', 'Expected', 'Opened', 'Resolved', 'Resolution', 'Alert status'], [...open.results, ...recent.results].map(i => `<tr>${[i.kind, i.expected_at, i.opened_at, i.resolved_at, i.resolution, i.alert_status].map(cell).join('')}</tr>`)));
}
