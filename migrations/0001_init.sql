-- All timestamps are ISO-8601 UTC strings supplied by the application.
CREATE TABLE tasks (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  schedule TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  grace_minutes INTEGER NOT NULL DEFAULT 15 CHECK (grace_minutes BETWEEN 1 AND 1440),
  alert_channel TEXT NOT NULL CHECK (alert_channel IN ('telegram', 'email')),
  alert_target TEXT NOT NULL,
  rerun_webhook_url TEXT,
  rerun_webhook_secret TEXT,
  ping_token_hash TEXT NOT NULL UNIQUE,
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_heartbeat_at TEXT,
  last_status TEXT CHECK (last_status IN ('ok', 'fail'))
);

CREATE TABLE heartbeats (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  received_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'fail')),
  run_id TEXT,
  output_url TEXT,
  message TEXT CHECK (message IS NULL OR length(message) <= 2000)
);
CREATE INDEX heartbeats_task_received_at ON heartbeats(task_id, received_at);

CREATE TABLE incidents (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('missed', 'failed')),
  expected_at TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT CHECK (resolution IN ('late_heartbeat', 'rerun_ok')),
  alert_status TEXT NOT NULL DEFAULT 'pending' CHECK (alert_status IN ('pending', 'sent', 'failed')),
  alert_error TEXT,
  rerun_token_hash TEXT,
  rerun_requested_at TEXT,
  rerun_status TEXT NOT NULL DEFAULT 'none' CHECK (rerun_status IN ('none', 'requested', 'succeeded', 'failed')),
  rerun_response_code INTEGER,
  rerun_error TEXT,
  UNIQUE (task_id, kind, expected_at)
);
