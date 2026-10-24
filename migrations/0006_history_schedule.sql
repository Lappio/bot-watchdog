CREATE TABLE scan_events (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('scan_opened_missed','scan_reminder','scan_error','scan_deliverable_failed','scan_deliverable_passed','rerun_unknown')),
  ref_id TEXT,
  detail TEXT
);
CREATE INDEX scan_events_task_at ON scan_events(task_id, at);
CREATE INDEX scan_events_at ON scan_events(at);
