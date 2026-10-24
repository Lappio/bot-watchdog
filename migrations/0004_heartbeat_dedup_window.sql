DROP INDEX heartbeats_task_run_status;
CREATE INDEX heartbeats_task_run_status ON heartbeats(task_id, run_id, status, received_at);
