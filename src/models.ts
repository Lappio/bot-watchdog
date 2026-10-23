export interface Task {
  id: string; name: string; schedule: string; timezone: string; grace_minutes: number;
  alert_channel: 'telegram' | 'email'; alert_target: string;
  rerun_webhook_url: string | null; rerun_webhook_secret: string | null; ping_token_hash: string;
  paused: number; created_at: string; updated_at: string; last_heartbeat_at: string | null;
  last_status: 'ok' | 'fail' | null;
}
export interface Incident {
  id: string; task_id: string; kind: 'missed' | 'failed'; expected_at: string;
  opened_at: string; resolved_at: string | null; resolution: string | null;
}
export function publicTask(task: Task) {
  const { ping_token_hash: _hash, rerun_webhook_secret: _secret, ...rest } = task;
  return { ...rest, paused: Boolean(task.paused), has_rerun_webhook: Boolean(task.rerun_webhook_url) };
}
