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
  with `*`, lists, ranges, steps) and an IANA `timezone` per task (default `UTC`). Validate on registration.

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
  paused (0/1), created_at, updated_at, last_heartbeat_at, last_status.
- heartbeats: id, task_id, received_at, status ('ok'|'fail'), run_id (nullable), output_url (nullable),
  message (nullable, truncated to 2000 chars). Index on (task_id, received_at).
- incidents: id (`inc_`+random), task_id, kind ('missed'|'failed'), expected_at (ISO, the scheduled occurrence; for
  'failed' use the heartbeat time), opened_at, resolved_at (nullable), resolution ('late_heartbeat'|'rerun_ok'|null),
  alert_status ('pending'|'sent'|'failed'), alert_error, rerun_token_hash, rerun_requested_at, rerun_status
  ('none'|'requested'|'succeeded'|'failed'), rerun_response_code, rerun_error.
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
  A heartbeat resolves any open 'missed' incident of that task whose expected_at <= received_at (resolution 'late_heartbeat')
  and sends a short "recovered (late)" notice on the task's channel. A status 'fail' heartbeat opens a 'failed' incident
  and alerts immediately.
- Rerun confirm (no admin auth; credential = single-use random token in the alert link):
  `GET /rerun/:incident_id?t=<token>` -> small HTML confirmation page with a POST form button (GET must NEVER trigger the
  webhook: chat/email link previewers prefetch GETs). `POST /rerun/:incident_id` with form field or JSON `t` -> triggers.
  Idempotent: an atomic conditional UPDATE (`WHERE rerun_requested_at IS NULL`) decides the single winner; only the winner
  POSTs the webhook. Repeat confirms return "already requested" page/JSON with current status, never a second POST.
  Webhook request: `POST rerun_webhook_url`, JSON `{ event: "bot-watchdog.rerun", task_id, task_name, incident_id, expected_at }`,
  headers `Content-Type: application/json`, `Idempotency-Key: <incident_id>`, and `Authorization: Bearer <secret>` if set.
  10s timeout. Record response code / error; 2xx -> rerun_status 'succeeded' (incident resolved 'rerun_ok'), else 'failed'.
  If the task has no webhook, the page says so and nothing is triggered. Never auto-rerun.

## Scanner (scheduled handler, every minute)
For each non-paused task: find the most recent cron occurrence `due` (in the task timezone) such that
`due + grace_minutes <= now` and `due >= task.created_at`. If there is no heartbeat with `received_at >= due`
(any heartbeat after the occurrence counts as that run) and no incident exists yet for (task,'missed',due), insert the
incident (INSERT OR IGNORE on the unique key; only send if the row was actually inserted), then send the alert.
Only the latest occurrence is checked per scan (no backfill storms after downtime).
Alert content: task name, expected time (UTC + task timezone), grace, last heartbeat time/status, and a
"Confirm re-run" link to `PUBLIC_BASE_URL/rerun/<incident_id>?t=<token>` (only if the task has a webhook).
Telegram: `POST https://api.telegram.org/bot<TOKEN>/sendMessage` with `chat_id`, text, and `reply_markup` inline keyboard
with a URL button "Confirm re-run". Email: Resend `POST https://api.resend.com/emails` with from/to/subject/html+text.
Scanner must be resilient: one task failing must not stop the others.

## Onboarding snippet (text the user pastes into their bot's task instructions)
Plain language for an AI agent, e.g.:
"At the very end of every run of this task (after you've delivered the result), send an HTTP POST to
<heartbeat_url> with JSON body {"status":"ok","run_id":"<any unique id for this run>","output_url":"<link to what you delivered, if any>"}.
If the task failed or you could not deliver, send the same request with "status":"fail" and a short "message".
Do this even if earlier steps failed. Equivalent curl: curl -fsS -m 10 -X POST <heartbeat_url> -H 'Content-Type: application/json' -d '{...}'"
Include task name, schedule, and grace in the snippet header.

## Testing rules
- All outbound fetches (Telegram, Resend, rerun webhooks) must be mocked in tests (e.g. `fetchMock` from `cloudflare:test`
  with `disableNetConnect()`, or an injectable fetch). No real network in tests.
- Tests must cover: validation, auth, heartbeat ok/fail, token rotate, snippet, scanner (not-yet-due, within grace, overdue ->
  one incident + one alert; second scan -> no duplicate; heartbeat after incident -> resolved), timezone/cron next/prev logic,
  rerun GET doesn't trigger, POST triggers exactly once, concurrent/double POST -> one webhook call, bad token -> 403/404.
- Scripts in package.json: `dev` (wrangler dev), `test` (vitest run), `typecheck` (tsc --noEmit),
  `db:migrate:local` (wrangler d1 migrations apply DB --local).
