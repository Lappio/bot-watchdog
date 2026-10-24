PRAGMA defer_foreign_keys = true;
CREATE TABLE incidents_new (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('missed', 'failed')),
  expected_at TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT CHECK (resolution IN ('late_heartbeat', 'rerun_ok', 'recovered')),
  alert_status TEXT NOT NULL DEFAULT 'pending' CHECK (alert_status IN ('pending', 'sent', 'failed')),
  alert_error TEXT,
  rerun_token_hash TEXT,
  rerun_requested_at TEXT,
  rerun_status TEXT NOT NULL DEFAULT 'none' CHECK (rerun_status IN ('none', 'requested', 'succeeded', 'failed', 'unknown')),
  rerun_response_code INTEGER,
  rerun_error TEXT,
  recovery_notice_status TEXT CHECK (recovery_notice_status IN ('sent', 'failed')),
  recovery_notice_error TEXT,
  rerun_unknown_alert_status TEXT CHECK (rerun_unknown_alert_status IN ('sent', 'failed')),
  rerun_unknown_alert_error TEXT,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  last_occurrence_at TEXT,
  last_reminder_at TEXT,
  UNIQUE (task_id, kind, expected_at)
);

INSERT INTO incidents_new (id,task_id,kind,expected_at,opened_at,resolved_at,resolution,alert_status,alert_error,rerun_token_hash,rerun_requested_at,rerun_status,rerun_response_code,rerun_error,recovery_notice_status,recovery_notice_error) SELECT id,task_id,kind,expected_at,opened_at,resolved_at,resolution,alert_status,alert_error,rerun_token_hash,rerun_requested_at,rerun_status,rerun_response_code,rerun_error,recovery_notice_status,recovery_notice_error FROM incidents;
DROP TABLE incidents;
ALTER TABLE incidents_new RENAME TO incidents;
ALTER TABLE tasks ADD COLUMN schedule_anchor_at TEXT;
UPDATE tasks SET schedule_anchor_at = created_at;
ALTER TABLE heartbeats ADD COLUMN dropped_fields TEXT;
CREATE UNIQUE INDEX heartbeats_task_run_status ON heartbeats(task_id, run_id, status) WHERE run_id IS NOT NULL;
