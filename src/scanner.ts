import type { Env } from './env';
import type { Incident, Task } from './models';
import { previousOccurrence } from './cron';
import { notifyIncidentOpened } from './alerts';
import { pingToken, randomId, sha256 } from './security';

export async function runScan(env: Env, now: Date): Promise<{ checked: number; opened: number; errors: number }> {
  const summary = { checked: 0, opened: 0, errors: 0 };
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
