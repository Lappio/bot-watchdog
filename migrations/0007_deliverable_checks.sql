PRAGMA defer_foreign_keys = true;
CREATE TABLE incidents_new (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('missed', 'failed', 'deliverable_missing')),
  expected_at TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT CHECK (resolution IN ('late_heartbeat', 'rerun_ok', 'recovered', 'deliverable_ok')),
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
  reminder_claim_until TEXT,
  UNIQUE (task_id, kind, expected_at)
);

INSERT INTO incidents_new (id,task_id,kind,expected_at,opened_at,resolved_at,resolution,alert_status,alert_error,rerun_token_hash,rerun_requested_at,rerun_status,rerun_response_code,rerun_error,recovery_notice_status,recovery_notice_error,rerun_unknown_alert_status,rerun_unknown_alert_error,occurrence_count,last_occurrence_at,last_reminder_at,reminder_claim_until) SELECT id,task_id,kind,expected_at,opened_at,resolved_at,resolution,alert_status,alert_error,rerun_token_hash,rerun_requested_at,rerun_status,rerun_response_code,rerun_error,recovery_notice_status,recovery_notice_error,rerun_unknown_alert_status,rerun_unknown_alert_error,occurrence_count,last_occurrence_at,last_reminder_at,reminder_claim_until FROM incidents;
DROP TABLE incidents;
ALTER TABLE incidents_new RENAME TO incidents;
ALTER TABLE tasks ADD COLUMN deliverable_check TEXT NOT NULL DEFAULT 'none' CHECK (deliverable_check IN ('none','http','github'));
ALTER TABLE tasks ADD COLUMN deliverable_config TEXT;
ALTER TABLE tasks ADD COLUMN deliverable_delay_minutes INTEGER NOT NULL DEFAULT 5 CHECK (deliverable_delay_minutes BETWEEN 0 AND 1440);
CREATE TABLE deliverable_checks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  heartbeat_id TEXT NOT NULL REFERENCES heartbeats(id) ON DELETE CASCADE,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','passed','failed','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  result_detail TEXT,
  opened_incident_id TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX deliverable_checks_due ON deliverable_checks(status, due_at);
