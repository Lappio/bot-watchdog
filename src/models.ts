export interface Task {
  id: string; name: string; schedule: string; timezone: string; grace_minutes: number;
  alert_channel: 'telegram' | 'email'; alert_target: string;
  rerun_webhook_url: string | null; rerun_webhook_secret: string | null; ping_token_hash: string;
  schedule_anchor_at: string | null; paused: number; created_at: string; updated_at: string; last_heartbeat_at: string | null;
  last_status: 'ok' | 'fail' | null;
}
export interface Incident {
  id: string; task_id: string; kind: 'missed' | 'failed'; expected_at: string;
  opened_at: string; resolved_at: string | null; resolution: 'late_heartbeat' | 'rerun_ok' | 'recovered' | null;
  alert_status: 'pending' | 'sent' | 'failed'; alert_error: string | null;
  recovery_notice_status: 'sent' | 'failed' | null; recovery_notice_error: string | null;
  rerun_token_hash: string | null; rerun_requested_at: string | null;
  rerun_status: 'none' | 'requested' | 'succeeded' | 'failed' | 'unknown';
  rerun_unknown_alert_status: 'sent' | 'failed' | null; rerun_unknown_alert_error: string | null;
  occurrence_count: number; last_occurrence_at: string | null; last_reminder_at: string | null; reminder_claim_until: string | null;
  rerun_response_code: number | null; rerun_error: string | null;
}
export function publicTask(task: Task) {
  const { ping_token_hash: _hash, rerun_webhook_secret: _secret, ...rest } = task;
  return { ...rest, paused: Boolean(task.paused), has_rerun_webhook: Boolean(task.rerun_webhook_url) };
}

export interface Heartbeat {
  id: string; task_id: string; received_at: string; status: 'ok' | 'fail';
  run_id: string | null; output_url: string | null; message: string | null;
  dropped_fields: string | null;
}
