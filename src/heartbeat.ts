import { previousOccurrence } from './cron';
import type { Env } from './env';
import { notifyIncidentOpened, notifyRecovered } from './alerts';
import { HttpError, jsonBody } from './http';
import type { Incident, Task } from './models';
import { randomId, sha256 } from './security';
import { httpUrl, invalid } from './validation';

export async function heartbeat(request: Request, env: Env, token: string, fail: boolean, ctx: ExecutionContext): Promise<Response> {
  const task = await env.DB.prepare('SELECT * FROM tasks WHERE ping_token_hash = ?').bind(await sha256(token)).first<Task>();
  if (!task) throw new HttpError(404, 'not_found', 'Unknown heartbeat token');
  const body = request.method === 'POST' ? await jsonBody(request, true) : {};
  if (body.status !== undefined && body.status !== 'ok' && body.status !== 'fail') invalid('status must be ok or fail');
  const status = fail ? 'fail' : body.status ?? 'ok';
  const dropped: string[] = [];
  if (body.run_id !== undefined && (typeof body.run_id !== 'string' || body.run_id.length > 200)) dropped.push('run_id');
  if (body.output_url !== undefined && (!httpUrl(body.output_url) || body.output_url.length > 2000)) dropped.push('output_url');
  if (body.message !== undefined && typeof body.message !== 'string') dropped.push('message');
  const runId = dropped.includes('run_id') ? null : body.run_id ?? null;
  const instant = new Date();
  const now = instant.toISOString();
  const dedupSince = (previousOccurrence(task.schedule, task.timezone, instant)
    ?? new Date(instant.getTime() - 10 * 60_000)).toISOString();
  const id = randomId('hb_');
  // A fresh row ID gates every side effect in the same atomic batch. A duplicate
  // run cannot update task state, resolve incidents, or increment occurrences.
  const gate = 'EXISTS (SELECT 1 FROM heartbeats WHERE id = ?)';
  const statements = [
    env.DB.prepare('INSERT INTO heartbeats (id, task_id, received_at, status, run_id, output_url, message, dropped_fields) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ? IS NULL OR NOT EXISTS (SELECT 1 FROM heartbeats WHERE task_id = ? AND run_id = ? AND status = ? AND received_at >= ?)')
      .bind(id, task.id, now, status, runId, dropped.includes('output_url') ? null : body.output_url ?? null, typeof body.message === 'string' ? body.message.slice(0, 2000) : null, dropped.length ? JSON.stringify(dropped) : null, runId, task.id, runId, status, dedupSince),
    env.DB.prepare(`UPDATE tasks SET last_heartbeat_at = ?, last_status = ? WHERE id = ? AND ${gate}`).bind(now, status, task.id, id),
  ];
  if (status === 'fail') {
    statements.push(
      env.DB.prepare(`UPDATE incidents SET occurrence_count = occurrence_count + 1, last_occurrence_at = ? WHERE task_id = ? AND kind = 'failed' AND resolved_at IS NULL AND ${gate}`).bind(now, task.id, id),
      env.DB.prepare(`INSERT INTO incidents (id, task_id, kind, expected_at, opened_at) SELECT ?, ?, 'failed', ?, ? WHERE ${gate} AND NOT EXISTS (SELECT 1 FROM incidents WHERE task_id = ? AND kind = 'failed' AND resolved_at IS NULL) RETURNING *`).bind(randomId('inc_'), task.id, now, now, id, task.id),
    );
  } else {
    statements.push(
      env.DB.prepare(`UPDATE incidents SET resolved_at = ?, resolution = 'late_heartbeat' WHERE task_id = ? AND kind = 'missed' AND resolved_at IS NULL AND expected_at <= ? AND ${gate} RETURNING *`).bind(now, task.id, now, id),
    );
    statements.push(env.DB.prepare(`UPDATE incidents SET resolved_at = ?, resolution = 'recovered' WHERE task_id = ? AND kind = 'failed' AND resolved_at IS NULL AND ${gate} RETURNING *`).bind(now, task.id, id));
  }
  const results = await env.DB.batch<Incident>(statements);
  if (results[0].meta.changes === 0) {
    const original = await env.DB.prepare('SELECT received_at FROM heartbeats WHERE task_id = ? AND run_id = ? AND status = ? AND received_at >= ? ORDER BY received_at DESC LIMIT 1').bind(task.id, runId, status, dedupSince).first<{ received_at: string }>();
    return Response.json({ ok: true, duplicate: true, task_id: task.id, received_at: original!.received_at });
  }
  task.last_heartbeat_at = now;
  task.last_status = status as 'ok' | 'fail';
  if (status === 'fail') {
    for (const incident of results[3].results) ctx.waitUntil(notifyIncidentOpened(env, task, incident));
  } else {
    for (const incident of results[2].results) ctx.waitUntil(notifyRecovered(env, task, incident));
    for (const incident of results[3].results) ctx.waitUntil(notifyRecovered(env, task, incident));
  }
  return Response.json({ ok: true, task_id: task.id, received_at: now, ...(dropped.length ? { dropped_fields: dropped } : {}) });
}
