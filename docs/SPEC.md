# bot-watchdog — product & API spec (Phase 1 MVP)

External watchdog for scheduled tasks on hosted agent platforms (e.g. Grok Bot). Alerts when a task
didn't run, ran late, or reported failure. Runs outside the platform (Cloudflare Workers + D1), so it
survives platform pauses/rate limits. Single-tenant MVP (one operator per deployment).

## Stack
- TypeScript, Cloudflare Workers (module syntax), D1 (binding name `DB`), wrangler v3/v4 (latest stable),
  vitest + @cloudflare/vitest-pool-workers (tests run inside workerd with a real local D1 and migrations applied).
- Cron trigger `* * * * *` -> `scheduled` handler runs the scanner.
- No web framework required; a tiny router is fine (Hono is also acceptable if it keeps things small).
- Cron expression handling: use a small, zero/low-dependency library that works in workerd (e.g. `croner`)
  OR a well-tested own 5-field parser. Must support standard 5-field cron (minute hour dom month dow,
  with `*`, lists, ranges, steps) and an IANA `timezone` per task (default `UTC`). Validate on create and PATCH: reject schedules without a next occurrence within approximately five years from now in the configured timezone, with 400 validation_error ("schedule never fires"). Cron next/previous helpers catch evaluation errors and return null.

## Config (env)
- vars (wrangler.toml [vars], non-secret): `PUBLIC_BASE_URL` (e.g. http://localhost:8787), `ALERT_FROM_EMAIL`.
- secrets (wrangler secret put / .dev.vars, NEVER committed; document with `.dev.vars.example` placeholders):
  `ADMIN_TOKEN` (bearer for management API), `TELEGRAM_BOT_TOKEN`, `RESEND_API_KEY` (email via Resend HTTP API).
- If a channel's secret is missing, the alert attempt is recorded as failed with a clear error; never crash the scan.
- wrangler.toml must use a placeholder `database_id` (e.g. "00000000-0000-0000-0000-000000000000") with a comment
  telling the user to run `wrangler d1 create bot-watchdog` and paste the id. No real account ids.

## Data model (D1 migrations in /migrations)
- tasks: id (text, e.g. `tsk_` + random), name, schedule (cron), timezone, grace_minutes (int, default 15, 1..1440),
  alert_channel ('telegram'|'email'), alert_target (telegram chat id or email address),
  rerun_webhook_url (nullable, must be https:// except http://localhost / 127.0.0.1 allowed for dev),
  rerun_webhook_secret (nullable; sent as `Authorization: Bearer <secret>` to the webhook),
  ping_token_hash (sha256 hex of the per-task ping token; plain token shown only on create/rotate),
  paused (0/1), created_at, updated_at, last_heartbeat_at, last_status, schedule_anchor_at (nullable text; migration backfills created_at).
- heartbeats: id, task_id, received_at, status ('ok'|'fail'), run_id (nullable), output_url (nullable),
  message (nullable, truncated to 2000 chars), dropped_fields (nullable text, JSON array of field names). Index on (task_id, received_at). Non-unique index on (task_id, run_id, status, received_at).
- incidents: id (`inc_`+random), task_id, kind ('missed'|'failed'), expected_at (ISO, the scheduled occurrence; for
  'failed' use the heartbeat time), opened_at, resolved_at (nullable), resolution ('late_heartbeat'|'rerun_ok'|'recovered'|null),
  alert_status ('pending'|'sent'|'failed'), alert_error (original alert delivery only),
  recovery_notice_status (null before attempt, otherwise 'sent'|'failed'), recovery_notice_error,
  rerun_token_hash, rerun_requested_at, rerun_status
  ('none'|'requested'|'succeeded'|'failed'|'unknown'), rerun_response_code, rerun_error,
  rerun_unknown_alert_status (nullable 'sent'|'failed'), rerun_unknown_alert_error (nullable text),
  occurrence_count (integer NOT NULL DEFAULT 1), last_occurrence_at (nullable text), last_reminder_at (nullable text).
  UNIQUE(task_id, kind, expected_at) so the scanner is idempotent.
All timestamps ISO-8601 UTC strings. Use parameterized queries only.

## HTTP API
Management endpoints require `Authorization: Bearer <ADMIN_TOKEN>` (constant-time compare). JSON errors:
`{ "error": { "code": "...", "message": "..." } }` with proper 4xx codes.

- `GET /healthz` -> `{ "ok": true }` (no auth)
- `POST /api/tasks` body `{ name, schedule, timezone?, grace_minutes?, alert_channel, alert_target, rerun_webhook_url?, rerun_webhook_secret? }`
  -> 201 `{ task: <public task>, ping_token, heartbeat_url, snippet }`. Validate all fields (400 on invalid cron/timezone/channel/email/url).
- `GET /api/tasks` -> `{ tasks: [...] }`; `GET /api/tasks/:id` -> `{ task, recent_heartbeats (last 20), open_incidents }`
- `PATCH /api/tasks/:id` (any of the mutable fields + `paused`) ; `DELETE /api/tasks/:id` (cascade its heartbeats/incidents)
- `POST /api/tasks/:id/rotate-token` -> `{ ping_token, heartbeat_url, snippet }` (old token stops working)
- `GET /api/tasks/:id/snippet` -> text/plain onboarding snippet with the token shown as `<YOUR_PING_TOKEN>` placeholder
  (the real token is only returned by create/rotate). Public task objects never expose token hashes or webhook secret
  (expose `has_rerun_webhook: true/false`).
- `GET /api/incidents?status=open|all` -> list.
- Heartbeat (no admin auth; the per-task ping token in the URL is the credential, write-only):
  `POST /hb/:ping_token` JSON body `{ status?: "ok"|"fail" (default ok), run_id?, output_url?, message? }`
  also `GET /hb/:ping_token` and `POST /hb/:ping_token/fail` as no-body shortcuts (for curl one-liners).
  -> 200 `{ ok: true, task_id, received_at }`; 404 on unknown token. Updates task.last_heartbeat_at/last_status.
  Only an ok heartbeat resolves any open 'missed' incident of that task whose expected_at <= received_at (resolution 'late_heartbeat')
  and sends a short "recovered (late)" notice on the task's channel. A status 'fail' heartbeat opens a 'failed' incident
  and queues an alert via ctx.waitUntil; all heartbeat database writes finish before responding, without waiting for delivery.
  Optional run_id must be a string <=200 characters; output_url an HTTP(S) URL <=2000 characters;
  message a string truncated to 2000 characters. Invalid optional values are dropped to null for either status,
  stored as JSON array text in heartbeats.dropped_fields, and returned as dropped_fields: [names] (omit when empty).
  Invalid JSON/non-object bodies and invalid status still return 400; empty bodies remain accepted.
  For non-null run_id, deduplicate (task_id, run_id, status) only against heartbeats received at or after previousOccurrence(schedule, timezone, now), the latest scheduled occurrence at/before now; use a rolling 10-minute window if none exists. A single INSERT ... SELECT ... WHERE NOT EXISTS statement starts the atomic batch, with a fresh row ID gating all side effects. Reusing a run_id in a later schedule period records a new heartbeat.
  Duplicates return 200 {ok:true, duplicate:true, task_id, received_at:<original time>} with no side effects.
  All incident/task mutations must be gated on insertion of the heartbeat, including concurrent requests.
  While an open failed incident exists, new failures increment occurrence_count and set last_occurrence_at
  without another incident or alert. Fail heartbeats never resolve missed or failed incidents.
  An ok heartbeat resolves open failed incidents with resolution recovered and resolved_at, and queues
  "recovered: an ok heartbeat was received after a failure". Record recovery_notice_status/error separately.
  Missed-incident recovery notices also run via ctx.waitUntil. Tests asserting delivery must await the execution context.
- Rerun confirm (no admin auth; credential = single-use random token in the alert link):
  `GET /rerun/:incident_id?t=<token>` -> small HTML confirmation page with a POST form button (GET must NEVER trigger the
  webhook: chat/email link previewers prefetch GETs). `POST /rerun/:incident_id` with form field or JSON `t` -> triggers.
  Idempotent: an atomic conditional UPDATE (`WHERE rerun_requested_at IS NULL AND resolved_at IS NULL AND rerun_status = 'none'`) decides the single winner; only the winner
  POSTs the webhook. Repeat confirms return "already requested" page/JSON with current status, never a second POST.
  Webhook request: `POST rerun_webhook_url`, JSON `{ event: "bot-watchdog.rerun", task_id, task_name, incident_id, expected_at }`,
  headers `Content-Type: application/json`, `Idempotency-Key: <incident_id>`, and `Authorization: Bearer <secret>` if set.
  10s timeout. Record response code / error; 2xx -> rerun_status 'succeeded' (incident resolved 'rerun_ok'), else 'failed'.
  Resolved incidents have no form and POST returns 409 JSON {ok:false,status:<rerun_status>,resolved:true,resolution}
  (or HTML for form posts). For late_heartbeat the page says "The task already ran on its own (a heartbeat arrived) — no re-run is needed.";
  rerun_ok says already re-run, recovered says task recovered, other resolutions say already resolved.
  Unknown results show their status without a button and POST returns 409 without calling the webhook.
  If the task has no webhook, the page says so and nothing is triggered. Never auto-rerun.

## Scanner (scheduled handler, every minute)
For each non-paused task: find the most recent cron occurrence `due` (in the task timezone) such that
`due + grace_minutes <= now` and `due >= (task.schedule_anchor_at ?? task.created_at)`. If there is no heartbeat with `received_at >= due`
(any heartbeat after the occurrence counts as that run) and no open missed incident exists for the task and no incident exists yet for (task,'missed',due), insert the
incident (INSERT OR IGNORE ... SELECT ... WHERE NOT EXISTS an open missed incident, on the unique occurrence key; only send if the row was actually inserted), then send the alert.
Only the latest occurrence is checked per scan (no backfill storms after downtime).
Alert content: task name, expected time (UTC + task timezone), grace, last heartbeat time/status, and a
"Confirm re-run" link to `PUBLIC_BASE_URL/rerun/<incident_id>?t=<token>` (only if the task has a webhook).
Telegram: `POST https://api.telegram.org/bot<TOKEN>/sendMessage` with `chat_id`, text, and `reply_markup` inline keyboard
with a URL button "Confirm re-run" only for https:// confirmation links. The link is always in text.
For a Telegram HTTP 400 with a button, resend once without reply_markup. Record the final attempt;
mention the fallback in alert_error only when that fallback fails. Email: Resend `POST https://api.resend.com/emails` with from/to/subject/html+text.
Scanner must be resilient: one task failing must not stop the others.
Each scan independently sweeps requested reruns older than RERUN_RESULT_TIMEOUT_MINUTES = 5 with no
response code or error recorded, even with no active tasks. Both the SELECT and claiming UPDATE require resolved_at IS NULL. A conditional UPDATE changes requested to unknown;
only its winner attempts one alert on the task channel, without a rerun link. The alert explains that the request
may already have been delivered but its result was never recorded; check whether the task actually ran; no automatic retry.
Record rerun_unknown_alert_status/error separately. This does not resolve the incident; a later heartbeat
still resolves missed incidents as late_heartbeat. Isolate the sweep in its own try/catch so task scanning continues.
Migration 0003_hardening.sql rebuilds incidents preserving all existing columns/data and the unique occurrence key,
and adds the task/heartbeat columns and initial partial unique index. Migration 0004 replaces that index with the non-unique heartbeat lookup index for schedule-period deduplication. Heartbeat dropped-field handling and failed-incident occurrence aggregation use these fields.
Public task objects expose schedule_anchor_at. Initialize it to created_at on create; reset it to now on PATCH only for paused true->false or an actual schedule/timezone change. No-op or unrelated patches preserve it. Occurrences strictly before the anchor never alert, including occurrences during pauses.
While a missed incident is open, aggregate newer overdue occurrences with a conditional UPDATE:
`WHERE id = ? AND resolved_at IS NULL AND (last_occurrence_at IS NULL OR last_occurrence_at < due) AND expected_at < due`;
increment occurrence_count and set last_occurrence_at = due once per observed occurrence. No new normal alert.
Remind when `now - (last_reminder_at ?? opened_at) >= min(24h, max(1h, (last_reminder_at ?? opened_at) - opened_at))`.
Serialize sends with a separate conditional reminder_claim_until lease (60 seconds, recoverable after a crash),
matching the previous last_reminder_at and resolved_at IS NULL. Only the claim winner delivers; release the lease
after the attempt. Advance last_reminder_at with a conditional compare-and-set only after successful delivery.
On failure preserve last_reminder_at so the next scan retries. Migration 0005 adds the nullable lease column.
Text says still missing, N missed occurrences since expected_at, last expected last_occurrence_at ?? expected_at,
and that sending a heartbeat resolves it. No rerun link. Log reminder delivery failures without overwriting alert_status/error.
With timely scans reminders occur at approximately +1h, +2h, +4h, +8h, +16h, then every 24h.
An ok heartbeat resolves the open missed incident as late_heartbeat; a subsequent miss opens a fresh incident and full alert.
Limitations: only the latest overdue occurrence is observed per scan; counts do not backfill downtime.
Scan delays shift reminder timing. Provider failures retry on the next scan; a crash leaves the claim retryable after its lease expires.
A crash after provider acceptance but before recording success can cause a duplicate reminder on retry.
Tasks whose cron cannot be evaluated increment scan errors and are skipped without affecting other tasks.

## Onboarding snippet (text the user pastes into their bot's task instructions)
Plain language tells the agent to POST at the end of every run, even after a failure, after delivering the result.
Explain optional run_id (unique for each run), output_url (HTTP(S) delivery link), and message (short reason),
and explicitly tell the agent to replace placeholders in prose. Runnable curl examples from create/rotate use
actual heartbeat URLs and literal JSON bodies {"status":"ok"} and
{"status":"fail","message":"short reason"}; neither body contains placeholders.
Use curl -fsS -m 10 -X POST with Content-Type: application/json and a shell-quoted -d body.
GET snippet substitutes <YOUR_PING_TOKEN> because the plaintext token is unavailable; replace it before execution.
JSON containing placeholders must never be labelled copy-pasteable.
Include task name, schedule, and grace in the snippet header.

## Testing rules
- All outbound fetches (Telegram, Resend, rerun webhooks) must be mocked in tests (e.g. `fetchMock` from `cloudflare:test`
  with `disableNetConnect()`, or an injectable fetch). No real network in tests.
- Tests must cover: validation, auth, heartbeat ok/fail, token rotate, snippet, scanner (not-yet-due, within grace, overdue ->
  one incident + one alert; second scan -> no duplicate; heartbeat after incident -> resolved), timezone/cron next/prev logic,
  rerun GET doesn't trigger, POST triggers exactly once, concurrent/double POST -> one webhook call, bad token -> 403/404.
- Scripts in package.json: `dev` (wrangler dev), `test` (vitest run), `typecheck` (tsc --noEmit),
  `db:migrate:local` (wrangler d1 migrations apply DB --local).

## Phase 2: history and cross-bot schedules
Migration `0006_history_schedule.sql` adds only `scan_events`: id (text primary key), task_id
(nullable FK to tasks, cascade delete), at (required UTC ISO timestamp), kind, ref_id and detail
(nullable text). Allowed kinds: scan_opened_missed, scan_reminder, scan_error,
scan_deliverable_failed, scan_deliverable_passed, rerun_unknown. Indexes cover (task_id, at) and at.
The scanner records missed-incident openings, successful reminder sends, rerun transitions to unknown,
and per-task errors. Inserts are best effort: a logging failure never interrupts scanning.
Deliverable event kinds are reserved for a later unit; deliverable checks are not implemented here.

`HISTORY_RETENTION_DAYS = 90` is exported from `src/history.ts`. At the end of every scan,
including scans with all tasks paused, delete heartbeats with received_at strictly before now minus
90 days, scan_events with at before that cutoff, and incidents with non-null resolved_at before
that cutoff. Preserve unresolved incidents regardless of age, and preserve rows exactly at the cutoff.
Task last-heartbeat summaries remain available after old heartbeat rows are pruned.

All four endpoints below require the existing admin bearer token (no cookies):
- `GET /api/tasks/:id/runs?limit=50&before=<ISO>` returns `{ runs, next_before, incidents }`.
  Runs are ordered by received_at DESC, id DESC. Limit defaults to 50 and is clamped to 1..200.
  A before cursor restricts received_at strictly below that timestamp; next_before is the oldest
  timestamp in the page, or null on an empty page. Equal timestamps can therefore be skipped at
  page boundaries. Incidents belong to the same task and have opened_at or expected_at within
  the inclusive oldest-to-newest run time window; empty pages return no incidents. Unknown tasks
  return 404; invalid before timestamps return 400.
- `GET /api/schedule` returns `{ tasks }` for every task, including paused ones. Fields: id, name,
  schedule, timezone, grace_minutes, paused (boolean), last_heartbeat_at, last_status,
  schedule_anchor_at, created_at, next_run, open_incidents. Compute next_run with nextOccurrence
  in the task timezone at request time, even while paused; null means no evaluable occurrence.
  Each open incident includes id, kind, expected_at, opened_at, alert_status. Sort next_run ascending,
  nulls last, then name. No alert targets or webhook credentials are exposed.
- `GET /admin/schedule` renders a self-contained read-only HTML table of names, schedules/timezones,
  next runs, last heartbeats/statuses, pause state, open incident summaries and task-history links.
- `GET /admin/tasks/:id/history` renders the task header, last 100 heartbeats ordered by
  received_at DESC, id DESC, all open incidents and up to 100 recently opened resolved incidents.
  Unknown tasks return 404. Both HTML routes return HTML 401 pages for missing/incorrect bearer
  credentials, escape dynamic content and reuse the rerun pages' no-store, CSP, frame and referrer
  security headers. Output URLs are displayed as escaped text.

History tests cover pagination, incident windows, paused schedule visibility, retention boundaries,
unresolved incident preservation, HTML authentication/escaping, and scanner event instrumentation.
