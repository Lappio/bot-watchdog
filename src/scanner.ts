import type { Env } from './env';
import type { Incident, Task } from './models';
import { previousOccurrence } from './cron';
import { notifyIncidentOpened, notifyRerunUnknown } from './alerts';
import { pingToken, randomId, sha256 } from './security';

export const RERUN_RESULT_TIMEOUT_MINUTES = 5;

export async function runScan(env: Env, now: Date): Promise<{ checked: number; opened: number; errors: number }> {
  const summary = { checked: 0, opened: 0, errors: 0 };
  // Independent sweep also runs when every task is paused or there are no due tasks.
  try {
    const cutoff = new Date(now.getTime() - RERUN_RESULT_TIMEOUT_MINUTES * 60000).toISOString();
    const { results: stale } = await env.DB.prepare("SELECT * FROM incidents WHERE rerun_status = 'requested' AND rerun_requested_at < ? AND rerun_response_code IS NULL AND rerun_error IS NULL").bind(cutoff).all<Incident>();
    for (const incident of stale) {
      try {
        const claimed = await env.DB.prepare("UPDATE incidents SET rerun_status = 'unknown' WHERE id = ? AND rerun_status = 'requested' AND rerun_requested_at < ? AND rerun_response_code IS NULL AND rerun_error IS NULL")
          .bind(incident.id, cutoff).run();
        if (claimed.meta.changes !== 1) continue;
        const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(incident.task_id).first<Task>();
        if (task) await notifyRerunUnknown(env, task, incident);
      } catch (error) {
        summary.errors++;
        console.error('Rerun timeout incident failed', incident.id, error instanceof Error ? error.message : 'Unknown error');
      }
    }
  } catch (error) {
    summary.errors++;
    console.error('Rerun timeout sweep failed', error instanceof Error ? error.message : 'Unknown error');
  }
  const { results: tasks } = await env.DB.prepare('SELECT * FROM tasks WHERE paused = 0').all<Task>();
  for (const task of tasks) {
    summary.checked++;
    try {
      const due = previousOccurrence(task.schedule, task.timezone, new Date(now.getTime() - task.grace_minutes * 60000));
      if (!due || due.getTime() < Date.parse(task.created_at)) continue;
      const expected = due.toISOString();
      if (await env.DB.prepare('SELECT id FROM heartbeats WHERE task_id = ? AND received_at >= ? LIMIT 1').bind(task.id, expected).first()) continue;
      const token = pingToken();
      const id = randomId('inc_');
      const inserted = await env.DB.prepare("INSERT OR IGNORE INTO incidents (id, task_id, kind, expected_at, opened_at, rerun_token_hash) VALUES (?, ?, 'missed', ?, ?, ?)")
        .bind(id, task.id, expected, now.toISOString(), await sha256(token)).run();
      if (inserted.meta.changes !== 1) continue;
      summary.opened++;
      const incident = await env.DB.prepare('SELECT * FROM incidents WHERE id = ?').bind(id).first<Incident>();
      if (incident) await notifyIncidentOpened(env, task, incident, token);
    } catch (error) {
      summary.errors++;
      console.error('Scan task failed', task.id, error instanceof Error ? error.message : 'Unknown error');
    }
  }
  return summary;
}
