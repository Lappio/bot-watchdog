# Phase 2 addendum (source of truth for this PR; merge into docs/SPEC.md)

## Leftover fixes (must ship)
A. Heartbeat resolving missed: ONLY status=ok may resolve open 'missed' incidents (resolution late_heartbeat). A fail heartbeat must leave missed open and open/aggregate a 'failed' incident + alert as today. SQL that resolves missed must not run for fail (or must gate on status).
B. Missed reminders: do NOT advance last_reminder_at until the reminder send succeeds. Claim with a provisional marker only if needed; on send failure leave last_reminder_at unchanged so the next scan retries. Prefer: select due reminder, send, then UPDATE last_reminder_at only on success (use a conditional compare-and-set on the previous last_reminder_at to avoid double-sends under concurrency — if another scan already advanced it, skip).
C. Reminder text "since …" must use the window's first expected_at (`incident.expected_at`), not `opened_at`. "last expected" stays last_occurrence_at ?? expected_at.

## Deliverable checks
Per-task (new columns on tasks; defaults keep existing behavior):
- deliverable_check: 'none' | 'http' | 'github' (default 'none')
- deliverable_config: TEXT JSON nullable. Shape:
  - http: `{ "url"?: string, "expect_status"?: number (default 200), "expect_contains"?: string }` — if url omitted, use heartbeat.output_url from the run being checked
  - github: `{ "type": "commit"|"pr"|"issue"|"file"|"url", "owner", "repo", "ref"?: string, "path"?: string, "number"?: number, "sha"?: string, "url"?: string }` — if url given and type url, GET that API/HTML URL with the PAT; otherwise use Octokit REST via fetch to api.github.com
- deliverable_delay_minutes: INTEGER 0..1440, default 5 (wait after ok heartbeat before checking)

Env secret (optional): `GITHUB_TOKEN` — classic/fine-grained PAT with read access; missing → check fails with clear error, no crash.
Slack and email connectors: interface stubs only (`src/deliverable/slack.ts`, `src/deliverable/email.ts` exporting `checkDeliverable(...): Promise<CheckResult>` that throws `not_implemented`); documented as follow-up. Do not add Slack/email OAuth.

Flow:
- On ok heartbeat that is NOT a duplicate: if task.deliverable_check !== 'none', insert a row into `deliverable_checks` (id, task_id, heartbeat_id, due_at = now+delay, status 'pending', attempts 0, result_json null, opened_incident_id null).
- Scanner each minute (or a dedicated sweep in runScan): claim due pending checks (due_at <= now, status pending), run checker, set status 'passed'|'failed', store result; on failed open incident kind 'deliverable_missing' (expected_at = heartbeat.received_at or check.due_at), alert like other incidents, with confirm-rerun if webhook configured. UNIQUE(task_id, kind, expected_at) — use heartbeat received_at as expected_at for deliverable_missing.
- Fail heartbeat never schedules a deliverable check.
- Rebuild incidents CHECK to include kind 'deliverable_missing' (migration).
- An ok heartbeat resolves open deliverable_missing the same way as failed→recovered (resolution 'recovered') OR leave them open until a later check passes — prefer: ok heartbeat does NOT auto-resolve deliverable_missing; only a subsequent passed check resolves it (resolution 'deliverable_ok'), and late ok without re-check leaves it. Simpler MVP: open deliverable_missing is resolved by a later ok heartbeat with resolution 'recovered' (same as failed), and also by a later passed check for the same task (resolution 'deliverable_ok'). Document both.

Checkers (src/deliverable/):
- http.ts: fetch url with redirect:manual, 10s timeout; pass if status matches expect_status (default 200-399 treat 2xx/3xx as ok if expect_status unset → require 2xx); optional body substring expect_contains (read up to 64KB).
- github.ts: Authorization Bearer GITHUB_TOKEN; call appropriate REST endpoint; 404 → fail; missing token → fail with clear error.
- index.ts: dispatch by type; CheckResult = { ok: boolean, detail: string }.

## Long-term run history
- heartbeats already store every run. Add `scan_events` table: id, task_id nullable, at, kind ('scan_opened_missed'|'scan_reminder'|'scan_error'|'scan_deliverable_failed'|'scan_deliverable_passed'|'rerun_unknown'), ref_id nullable, detail TEXT nullable. Scanner writes these (best-effort, never fail the scan).
- GET /api/tasks/:id/runs?limit=50&before=<ISO> — paginated heartbeats newest first (cursor = before received_at), includes linked open/closed incidents by proximity optional; keep lean: return heartbeats + any incidents whose expected_at/opened_at falls in the page window.
- Retention: constant HISTORY_RETENTION_DAYS = 90; each scan deletes heartbeats, scan_events, and resolved incidents older than retention (keep unresolved). Document.

## Cross-bot schedule view
- GET /api/schedule — JSON `{ tasks: [{ id, name, schedule, timezone, grace_minutes, paused, next_run, last_heartbeat_at, last_status, open_incidents: [{id,kind,expected_at,opened_at}], deliverable_check }] }` sorted by next_run nulls last. next_run via nextOccurrence(...).
- GET /admin/schedule — read-only HTML table of the same data (escape all). Auth: Authorization Bearer ADMIN_TOKEN (same as API). No cookies.
- GET /admin/tasks/:id/history — HTML table of recent heartbeats + incidents for that task.

## Validation / public task
- Extend taskInput for new fields; publicTask exposes them (not secrets).
- Update create/patch tests, README (EN + 简体中文 section), docs/SPEC.md fully for phase 2 + leftover fixes.
