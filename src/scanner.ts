import type { Env } from './env';
import type { Incident, Task } from './models';
import { previousOccurrence } from './cron';
import { notifyIncidentOpened, notifyMissedReminder, notifyRerunUnknown } from './alerts';
import { pingToken, randomId, sha256 } from './security';

export const RERUN_RESULT_TIMEOUT_MINUTES = 5;

export async function runScan(env: Env, now: Date): Promise<{ checked: number; opened: number; errors: number }> {
  const summary = { checked: 0, opened: 0, errors: 0 };
  // Independent sweep also runs when every task is paused or there are no due tasks.
  try {
    const cutoff = new Date(now.getTime() - RERUN_RESULT_TIMEOUT_MINUTES * 60000).toISOString();
    const { results: stale } = await env.DB.prepare("SELECT * FROM incidents WHERE resolved_at IS NULL AND rerun_status = 'requested' AND rerun_requested_at < ? AND rerun_response_code IS NULL AND rerun_error IS NULL").bind(cutoff).all<Incident>();
    for (const incident of stale) {
      try {
        const claimed = await env.DB.prepare("UPDATE incidents SET rerun_status = 'unknown' WHERE id = ? AND resolved_at IS NULL AND rerun_status = 'requested' AND rerun_requested_at < ? AND rerun_response_code IS NULL AND rerun_error IS NULL")
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
      if (!due) throw new Error('Schedule cannot be evaluated');
      const anchor = task.schedule_anchor_at ?? task.created_at;
      if (due.getTime() < Date.parse(anchor)) continue;
      const expected = due.toISOString();
      if (await env.DB.prepare('SELECT id FROM heartbeats WHERE task_id = ? AND received_at >= ? LIMIT 1').bind(task.id, expected).first()) continue;
      const open = await env.DB.prepare("SELECT * FROM incidents WHERE task_id = ? AND kind = 'missed' AND resolved_at IS NULL AND expected_at >= ? ORDER BY opened_at LIMIT 1").bind(task.id, anchor).first<Incident>();
      if (open) {
        await env.DB.prepare("UPDATE incidents SET occurrence_count = occurrence_count + 1, last_occurrence_at = ? WHERE id = ? AND resolved_at IS NULL AND (last_occurrence_at IS NULL OR last_occurrence_at < ?) AND expected_at < ?")
          .bind(expected, open.id, expected, expected).run();
        const reference = open.last_reminder_at ?? open.opened_at;
        const interval = Math.min(24 * 3600000, Math.max(3600000, Date.parse(reference) - Date.parse(open.opened_at)));
        if (now.getTime() - Date.parse(reference) >= interval) {
          // A separate lease serializes sends without consuming the backoff slot.
          // It expires after a crash and exceeds the provider's 10-second timeout.
          const leaseUntil = new Date(now.getTime() + 60000).toISOString();
          const claimed = await env.DB.prepare('UPDATE incidents SET reminder_claim_until = ? WHERE id = ? AND resolved_at IS NULL AND last_reminder_at IS ? AND (reminder_claim_until IS NULL OR reminder_claim_until <= ?)')
            .bind(leaseUntil, open.id, open.last_reminder_at, now.toISOString()).run();
          if (claimed.meta.changes === 1) {
            try {
              const current = await env.DB.prepare('SELECT * FROM incidents WHERE id = ? AND resolved_at IS NULL').bind(open.id).first<Incident>();
              if (current && await notifyMissedReminder(env, task, current)) {
                await env.DB.prepare('UPDATE incidents SET last_reminder_at = ? WHERE id = ? AND resolved_at IS NULL AND last_reminder_at IS ? AND reminder_claim_until = ?')
                  .bind(now.toISOString(), open.id, open.last_reminder_at, leaseUntil).run();
              }
            } finally {
              await env.DB.prepare('UPDATE incidents SET reminder_claim_until = NULL WHERE id = ? AND reminder_claim_until = ?')
                .bind(open.id, leaseUntil).run();
            }
          }
        }
        continue;
      }
      const token = pingToken();
      const id = randomId('inc_');
      const inserted = await env.DB.prepare("INSERT OR IGNORE INTO incidents (id, task_id, kind, expected_at, opened_at, rerun_token_hash) SELECT ?, ?, 'missed', ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM incidents WHERE task_id = ? AND kind = 'missed' AND resolved_at IS NULL AND expected_at >= ?)")
        .bind(id, task.id, expected, now.toISOString(), await sha256(token), task.id, anchor).run();
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
