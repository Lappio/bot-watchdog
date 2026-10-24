# bot-watchdog

An external watchdog for scheduled tasks on hosted agent platforms such as Grok Bot. It runs on Cloudflare Workers with D1, outside the agent platform, so monitoring survives platform pauses and rate limits. This is a single-tenant MVP: one operator per deployment. [docs/SPEC.md](docs/SPEC.md) defines the product and API.

Each task sends a heartbeat after delivering its result. Every minute, the scanner checks its cron schedule in its configured timezone, allowing a configurable grace period. Missing heartbeats and explicit failures produce Telegram or email alerts. A late heartbeat resolves eligible missed incidents and sends a recovery notice. If you configure a rerun webhook, the alert includes a confirmation link. **It never automatically reruns a task.** Opening that link displays a form; only confirming with POST can call the webhook.

## Local quickstart

Use Node 22 (also specified in `.nvmrc`).

```sh
npm install
cp .dev.vars.example .dev.vars
# Edit .dev.vars: choose a random ADMIN_TOKEN and configure your alert provider.
npm run db:migrate:local
npx wrangler dev --local --test-scheduled
```

In another terminal, set the same admin token you put in `.dev.vars`:

```sh
export ADMIN_TOKEN='replace-with-your-admin-token'
export BASE='http://localhost:8787'
curl "$BASE/healthz"
# {"ok":true}

curl -X POST "$BASE/api/tasks" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Daily report","schedule":"* * * * *","timezone":"UTC","grace_minutes":1,"alert_channel":"telegram","alert_target":"123456789"}'
```

Save `task.id`, `ping_token`, and `snippet` from the response. Paste the returned snippet into the bot's task instructions. The following placeholders must be replaced with those returned values:

```sh
export TASK_ID='tsk_REPLACE_ME'
export PING_TOKEN='REPLACE_ME'
curl -X POST "$BASE/hb/$PING_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"status":"ok","run_id":"manual-1"}'
curl 'http://localhost:8787/__scheduled?cron=*+*+*+*+*'
curl "$BASE/api/incidents?status=all" -H "Authorization: Bearer $ADMIN_TOKEN"
```

`/__scheduled` is Wrangler's local scheduled-event testing endpoint, not a deployed management API. To see a missed incident, stop sending heartbeats and wait until an occurrence after task creation is overdue by its grace period, then trigger a scan. Missing provider credentials record failed delivery; they do not stop scanning other tasks. Local development can send real alerts when valid provider credentials are configured.

## API reference

Examples below use `$BASE`, `$ADMIN_TOKEN`, `$TASK_ID`, and `$PING_TOKEN` as above. All `/api/*` endpoints require `Authorization: Bearer <ADMIN_TOKEN>`. Health is public; heartbeat URLs use the per-task token; rerun URLs use the incident's confirmation token. Timestamps are ISO-8601 UTC strings. JSON request bodies must be objects.

### Health

`GET /healthz` → 200 `{"ok":true}`. No authentication.

### Create a task

`POST /api/tasks` → 201. Example request:

```json
{
  "name": "Daily report",
  "schedule": "0 9 * * *",
  "timezone": "Asia/Shanghai",
  "grace_minutes": 15,
  "alert_channel": "email",
  "alert_target": "operator@example.com",
  "rerun_webhook_url": "https://hooks.example.com/run",
  "rerun_webhook_secret": "receiver-secret"
}
```

Required: `name` (1–100 characters, not blank), standard five-field `schedule` (lists, ranges, steps supported), `alert_channel` (`telegram` or `email`), and `alert_target`. Email targets must resemble an email address; Telegram targets accept numeric chat IDs (including negative IDs) or `@channel_name` (5–32 characters after `@`, starting with a letter).

Optional: `timezone` (IANA name, default `UTC`), `grace_minutes` (integer 1–1440, default 15), `rerun_webhook_url` (default null; HTTPS, with HTTP allowed for `localhost`/`127.0.0.1`), and `rerun_webhook_secret` (null or up to 512 characters). Unknown fields are ignored. Creation always starts unpaused. Create and PATCH reject schedules with no next occurrence within approximately five years in the configured timezone (400 `validation_error`, "schedule never fires"). Public task objects include `schedule_anchor_at`.

Response example (IDs, tokens, and timestamps are illustrative; `snippet` contains the full text shown below):

```json
{
  "task": {
    "id": "tsk_example",
    "name": "Daily report",
    "schedule": "0 9 * * *",
    "timezone": "Asia/Shanghai",
    "grace_minutes": 15,
    "alert_channel": "email",
    "alert_target": "operator@example.com",
    "rerun_webhook_url": "https://hooks.example.com/run",
    "paused": false,
    "schedule_anchor_at": "2026-10-24T00:00:00.000Z",
    "created_at": "2026-10-24T00:00:00.000Z",
    "updated_at": "2026-10-24T00:00:00.000Z",
    "last_heartbeat_at": null,
    "last_status": null,
    "has_rerun_webhook": true
  },
  "ping_token": "example-token",
  "heartbeat_url": "http://localhost:8787/hb/example-token",
  "snippet": "Task: Daily report\nSchedule: ..."
}
```

Public task objects have the fields above, excluding token hashes and webhook secrets. Only creation and rotation return the plaintext ping token.

### List and inspect tasks

```sh
curl "$BASE/api/tasks" -H "Authorization: Bearer $ADMIN_TOKEN"
curl "$BASE/api/tasks/$TASK_ID" -H "Authorization: Bearer $ADMIN_TOKEN"
```

`GET /api/tasks` → 200 `{"tasks":[<public task>]}`, newest creation first.

`GET /api/tasks/:id` → 200 `{"task":<public task>,"recent_heartbeats":[],"open_incidents":[]}`. Includes the latest 20 heartbeats, newest first, and unresolved incidents. Heartbeat rows contain `id`, `task_id`, `received_at`, `status`, `run_id`, `output_url`, `message`, and `dropped_fields`; optional values are null. `dropped_fields` is stored as JSON array text when fields were dropped.

### Update and delete tasks

```sh
curl -X PATCH "$BASE/api/tasks/$TASK_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"paused":true,"grace_minutes":30}'
curl -X DELETE "$BASE/api/tasks/$TASK_ID" -H "Authorization: Bearer $ADMIN_TOKEN"
```

`PATCH /api/tasks/:id` accepts any creation fields plus boolean `paused`, preserving omitted fields. Use null to clear webhook URL/secret. Returns 200 `{"task":<public task>}`. Pausing skips scheduled scans; heartbeat ingestion and explicit failure alerts still work.

`DELETE /api/tasks/:id` → 200 `{"ok":true}`. Deletes the task and its heartbeats/incidents.

### Rotate credentials and retrieve the snippet

```sh
curl -X POST "$BASE/api/tasks/$TASK_ID/rotate-token" -H "Authorization: Bearer $ADMIN_TOKEN"
curl "$BASE/api/tasks/$TASK_ID/snippet" -H "Authorization: Bearer $ADMIN_TOKEN"
```

`POST /api/tasks/:id/rotate-token` → 200 `{"ping_token":"new-token","heartbeat_url":"http://localhost:8787/hb/new-token","snippet":"Task: ..."}`. Immediately invalidates the old token; update the bot instructions.

`GET /api/tasks/:id/snippet` → 200 `text/plain`, with `<YOUR_PING_TOKEN>` in place of the unavailable plaintext token.

### Heartbeats

No admin authentication. The token in the URL is the credential.

```sh
curl -X POST "$BASE/hb/$PING_TOKEN" -H 'Content-Type: application/json' \
  -d '{"status":"ok","run_id":"report-2026-10-24","output_url":"https://example.com/report","message":"Delivered"}'
curl "$BASE/hb/$PING_TOKEN"
curl -X POST "$BASE/hb/$PING_TOKEN/fail"
```

- `POST /hb/:ping_token`: optional JSON body; `status` defaults to `ok`, otherwise must be `ok` or `fail`. An empty body is accepted.
- `GET /hb/:ping_token`: no-body success shortcut; it records a heartbeat.
- `POST /hb/:ping_token/fail`: no-body failure shortcut; forces `fail` even if a supplied JSON body says `ok`.

Optional `run_id` is a string up to 200 characters; `output_url` is an HTTP(S) URL up to 2000 characters; `message` is a string truncated to 2000 characters. Invalid optional values are dropped and stored as null, for both success and failure heartbeats. Their names are stored in `heartbeats.dropped_fields` as JSON array text and returned as `dropped_fields`, for example `{"ok":true,"task_id":"tsk_example","received_at":"2026-10-24T01:00:00.000Z","dropped_fields":["output_url"]}`. When none are dropped, the response omits this field. Invalid JSON, non-object bodies, and invalid `status` still return 400. Unknown tokens return 404.

Success → 200 `{"ok":true,"task_id":"tsk_example","received_at":"2026-10-24T01:00:00.000Z"}` after database writes complete. Alerts and recovery notices run in `ctx.waitUntil(...)`; the response does not wait for providers. Delivery results are recorded asynchronously on the incident.

A repeated non-null `(task_id, run_id, status)` within the current schedule period returns 200 `{"ok":true,"duplicate":true,"task_id":"tsk_example","received_at":"2026-10-24T01:00:00.000Z"}` with the most recent matching receipt time. The period starts at the latest scheduled occurrence at or before receipt time in the task timezone; if none exists, a rolling 10-minute window applies. The same run ID in a later period records a new heartbeat. Run IDs are optional and, if supplied, should be unique per run (for example, include the date/time). Concurrent duplicates are safe: they add no heartbeat, task update, incident occurrence, or notification. The same run can report both `fail` and `ok`; omitted or dropped run IDs are not deduplicated.

Any new heartbeat resolves open missed incidents with `expected_at <= received_at`, with resolution `late_heartbeat`; this includes failure heartbeats. A failure heartbeat opens a failed incident and queues an alert. While a failed incident remains open, additional failures increment its `occurrence_count` and set `last_occurrence_at`, without another incident or alert. Failures leave failed incidents open. An `ok` heartbeat resolves open failed incidents with `resolution: "recovered"` and `resolved_at`, and queues a notice saying "recovered: an ok heartbeat was received after a failure". Its delivery is tracked separately in `recovery_notice_status/error`.

### Incidents

```sh
curl "$BASE/api/incidents?status=open" -H "Authorization: Bearer $ADMIN_TOKEN"
curl "$BASE/api/incidents?status=all" -H "Authorization: Bearer $ADMIN_TOKEN"
```

`GET /api/incidents?status=open|all` → 200 `{"incidents":[...]}`; defaults to `open`, sorted by opening time descending. Example row:

```json
{
  "id": "inc_example",
  "task_id": "tsk_example",
  "kind": "missed",
  "expected_at": "2026-10-24T01:00:00.000Z",
  "opened_at": "2026-10-24T01:15:00.000Z",
  "resolved_at": null,
  "resolution": null,
  "alert_status": "sent",
  "alert_error": null,
  "recovery_notice_status": null,
  "recovery_notice_error": null,
  "rerun_token_hash": "example-sha256-hex",
  "rerun_requested_at": null,
  "rerun_status": "none",
  "rerun_response_code": null,
  "rerun_error": null
}
```

Migration 0003 also adds `occurrence_count` (default 1), nullable `last_occurrence_at` and `last_reminder_at`, task `schedule_anchor_at` (existing tasks backfilled from creation), and heartbeat `dropped_fields` (nullable JSON array text). Failed incidents aggregate occurrences, and heartbeat ingestion records dropped optional fields. Missed incidents aggregate observed overdue occurrences and use backoff reminders; schedule anchoring excludes occurrences before creation, resume, or schedule/timezone changes.

Incident endpoints return stored rows, including the rerun token hash, never its plaintext. `kind` is `missed` or `failed`; failed incidents use heartbeat receipt time as `expected_at`. Original alert status is `pending`, `sent`, or `failed`. Recovery notice status starts null and becomes `sent` or `failed`, with a separate error; it never overwrites the original alert result. Resolution is null, `late_heartbeat`, `rerun_ok`, or `recovered`. Rerun status is `none`, `requested`, `succeeded`, `failed`, or `unknown`.

### Confirm a rerun

`GET /rerun/:incident_id?t=<token>` → 200 HTML confirmation page. Use the link in the alert. GET never invokes the webhook. With no webhook configured the page explains that nothing can be triggered. Resolved incidents show no form: late heartbeats say the task already ran on its own, successful reruns say already re-run, and recovered tasks say they recovered. POST on a resolved incident returns 409 with `{ok:false,status:<rerun_status>,resolved:true,resolution}` (or HTML for a form post). The atomic claim checks that the incident is still unresolved, including when a heartbeat arrives during confirmation. Unknown results also show no button and return 409 on POST.

`POST /rerun/:incident_id` accepts a form field `t` (`application/x-www-form-urlencoded`) or JSON:

```sh
curl -X POST "$BASE/rerun/inc_example" -H 'Content-Type: application/json' \
  -d '{"t":"token-from-alert"}'
```

JSON success → 200 `{"ok":true,"status":"succeeded"}`. A repeat/concurrent confirmation → 409 `{"ok":false,"status":"requested"}` (or the current final status). No webhook → 409 with status `none`. Webhook failure → 502 `{"ok":false,"status":"failed"}`. Form submissions or requests accepting `text/html` receive an HTML page instead.

Only the winner of an atomic database claim sends the webhook, once. The request has a 10-second timeout, does not follow redirects, and uses:

```http
POST /run
Content-Type: application/json
Idempotency-Key: inc_example
Authorization: Bearer receiver-secret
```

```json
{"event":"bot-watchdog.rerun","task_id":"tsk_example","task_name":"Daily report","incident_id":"inc_example","expected_at":"2026-10-24T01:00:00.000Z"}
```

Authorization is included only when a webhook secret is set. A 2xx response marks the rerun succeeded and resolves the incident as `rerun_ok`; other responses or network failures record an error. This records webhook acceptance, not proof that the bot completed the rerun. Failed requests are not automatically retried.

### Errors

Management and heartbeat errors, plus unmatched routes, use JSON such as:

```json
{"error":{"code":"validation_error","message":"grace_minutes must be an integer from 1 to 1440"}}
```

Common statuses/codes: 400 `validation_error` or `invalid_json`; 401 `unauthorized`; 404 `not_found`; 405 `method_not_allowed` for recognized management routes; 503 `admin_not_configured`; 500 `internal_error`. Unmatched routes/methods can return 404.

Rerun endpoints have distinct responses: missing incident/task → 404 HTML, missing/invalid token → 403 HTML, unsupported method → 405 HTML. Malformed POST JSON → 400 `{"ok":false,"status":"invalid_body"}` (or HTML when requested). Delivery failures are recorded on incidents rather than returned as heartbeat errors.

## Onboarding paste snippet

Example output from `GET /api/tasks/:id/snippet` for the daily report above (replace `<YOUR_PING_TOKEN>` before executing; create/rotate return runnable examples with the real token):

```text
Task: Daily report
Schedule: 0 9 * * * (Asia/Shanghai)
Grace: 15 minutes

At the very end of every run of this task (after you've delivered the result), send an HTTP POST to
http://localhost:8787/hb/<YOUR_PING_TOKEN>
with JSON body {"status":"ok"}. Optional run_id, if used, must be unique per run (for example, include the date/time); optional output_url is an HTTP(S) link to what you delivered; optional message is a short explanation. Replace any placeholders in the prose with your actual values.
If the task failed or you could not deliver, send the same request with "status":"fail" and a short "message", or POST to http://localhost:8787/hb/<YOUR_PING_TOKEN>/fail.
Do this even if earlier steps failed.
Equivalent curl: curl -fsS -m 10 -X POST 'http://localhost:8787/hb/<YOUR_PING_TOKEN>' -H 'Content-Type: application/json' -d '{"status":"ok"}'
Failure curl: curl -fsS -m 10 -X POST 'http://localhost:8787/hb/<YOUR_PING_TOKEN>' -H 'Content-Type: application/json' -d '{"status":"fail","message":"short reason"}'
```

Telegram confirmation links always appear in message text. HTTPS links also get an inline button; the local HTTP default gets a text link only. If Telegram returns HTTP 400 for an alert with a button, delivery retries once without the button. The final attempt determines alert status; a fallback failure is noted in alert_error.

Creation/rotation substitute the real token. For deployment, set `PUBLIC_BASE_URL` to the reachable Worker URL before generating snippets and alerts.

## Configuration and deployment

| Setting | Location | Purpose |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | `wrangler.toml` vars | Absolute base URL for heartbeat and confirmation links |
| `ALERT_FROM_EMAIL` | `wrangler.toml` vars | Sender address for Resend; use a sender allowed by your Resend setup |
| `ADMIN_TOKEN` | secret / local `.dev.vars` | Management API bearer credential |
| `TELEGRAM_BOT_TOKEN` | secret / local `.dev.vars` | Telegram alert delivery |
| `RESEND_API_KEY` | secret / local `.dev.vars` | Email alert delivery |
| `DB` | D1 binding | Tasks, heartbeats, incidents |

Keep `.dev.vars` private. `.dev.vars.example` contains placeholders. Only the provider used by a task needs credentials; missing provider secrets produce a recorded failed alert or recovery notice. Missing `ADMIN_TOKEN` disables management with 503.

You run deployment yourself; this repository and CI do not deploy it. With your own Cloudflare account:

```sh
npx wrangler d1 create bot-watchdog
# Paste the returned database_id into wrangler.toml, replacing the all-zero placeholder.
# Set PUBLIC_BASE_URL and ALERT_FROM_EMAIL in wrangler.toml.
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put RESEND_API_KEY
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy
```

Set only the provider secrets you use. The cron trigger is already configured for every minute. Existing installations must apply all migrations too: `0002_recovery_notice.sql` adds recovery delivery fields; `0003_hardening.sql` rebuilds incidents with the expanded status constraints and adds the hardening columns and initial heartbeat unique index; `0004_heartbeat_dedup_window.sql` replaces that index with a non-unique index for schedule-period deduplication. For local databases use `npm run db:migrate:local`.

## Security and operational limits

Ping and rerun tokens are random credentials stored as SHA-256 hashes. Admin comparisons use fixed-length digests and constant-time comparison. Webhook secrets are stored in D1 and excluded from public task responses; they are not hashed because they must be sent to the receiver. Protect database access, admin credentials, heartbeat URLs, and confirmation links. URLs can appear in logs and message history. Rotate compromised ping tokens.

Rerun GET requests never trigger execution, so link previews cannot confirm a rerun. The GET heartbeat shortcut does record a heartbeat: prefer POST in bot instructions. Rerun confirmation is single-shot and idempotent even under concurrent submissions. Webhook receivers should also enforce the `Idempotency-Key` header to avoid duplicate work. A crash after claiming a rerun can leave its result unrecorded. Each scheduled scan changes unresolved requests older than five minutes with no recorded result to `unknown` and attempts one separate alert, even for paused tasks. The alert has no rerun link: the request may already have reached the webhook, so check whether the task ran. There is no automatic retry. The incident stays open; a later heartbeat resolves a missed incident normally. Delivery is tracked in `rerun_unknown_alert_status/error`.

Monitoring depends on the bot sending a heartbeat; it does not independently verify delivery. Grace is configurable per task. The scanner checks only the latest occurrence whose grace has elapsed, skips occurrences strictly before `schedule_anchor_at ?? created_at`, and treats any heartbeat at or after that occurrence as evidence of a run. It does not backfill missed runs after downtime. The anchor is initialized to creation time and reset to now on resume or an actual schedule/timezone change; no-op patches and unrelated edits preserve it. Paused time and occurrences before a schedule change do not count as missed. While a missed incident remains open, newer overdue occurrences increment its `occurrence_count` and update `last_occurrence_at` once per observed occurrence, with no new incident or normal alert. Reminders have no rerun link and are claimed once at approximately 1, 2, 4, 8, and 16 hours after opening, then every 24 hours (scan delays can shift this timing). A heartbeat resolves the incident; the next miss opens a fresh incident with a full alert. Reminder delivery failures are logged without changing the original alert status. A unique incident key prevents duplicate alerts for the same occurrence; failed deliveries are recorded without automatic retries. Counts reflect occurrences observed by scans, not backfilled runs. Cron evaluation failures count as scan errors and do not stop other tasks. Reminder claims precede delivery, so a crash or provider failure can lose a reminder; there is no delivery retry. Only unpaused tasks are scanned. The task detail API exposes the latest 20 heartbeats; there is no run-history browsing API. This deployment serves one tenant.

## Development and CI

```sh
npm run typecheck
npm test
```

Tests run in workerd with local D1 migrations and mocked outbound requests; external network connections are disabled in tests. GitHub Actions runs `npm ci`, typecheck, and tests on pushes and pull requests using Node 22 with read-only repository permissions.

## Phase 2 roadmap

These are planned, not implemented:

- Deliverable checks through read-only Slack, email, and GitHub access.
- Long-term run history beyond the hosted platform's last 20 runs.
- A cross-bot schedule view.
- Telegram callback buttons for confirmation (current alerts use URL buttons).
- Multi-tenant operation.

## 简体中文

bot-watchdog 是运行在 Cloudflare Workers + D1 上的外部定时任务看门狗，适用于 Grok Bot 等托管智能体平台。平台暂停或限流时，它仍能独立监控。任务完成后发送心跳；超过 cron 时间和宽限期未收到心跳，或任务报告失败时，通过 Telegram 或邮件告警。可配置重新运行的 webhook，但必须手动确认，绝不自动重跑。当前为单租户版本。

快速开始：安装 Node 22，运行 `npm install`，复制 `cp .dev.vars.example .dev.vars` 并填写管理令牌及告警渠道密钥，然后运行 `npm run db:migrate:local` 和 `npx wrangler dev --local --test-scheduled`。按上方 curl 示例创建任务，将返回的 `snippet` 粘贴到机器人的任务指令中。用 `curl 'http://localhost:8787/__scheduled?cron=*+*+*+*+*'` 手动触发本地扫描，再通过管理 API 查看事件。生产环境需自行创建 D1 数据库、填写数据库 ID、配置公开 URL 和密钥、应用远程迁移并部署。

## Phase 2: history and schedule views

After applying migration `0006_history_schedule.sql`, use your `Authorization: Bearer <ADMIN_TOKEN>`
header to access `/admin/schedule` and `/admin/tasks/:id/history`. The schedule includes paused tasks,
next scheduled runs and open incidents; task history shows the last 100 heartbeats and open/recent incidents.
These pages use bearer headers, with no cookie login.

JSON clients can use `GET /api/schedule` and `GET /api/tasks/:id/runs?limit=50&before=<ISO>`.
Run pages return `runs`, `incidents` in the page's time window, and `next_before`; pass that timestamp
as `before` for the next page (limit 1–200). Timestamp-only pagination may skip runs sharing the
boundary timestamp. A null cursor means the page is empty.

Every scan prunes heartbeats and scan events older than 90 days, plus incidents resolved more than
90 days ago. Unresolved incidents are retained. Scanner events record missed openings, successful
reminders, rerun unknown transitions and per-task errors on a best-effort basis. Deliverable checks
will be added in the next unit.
