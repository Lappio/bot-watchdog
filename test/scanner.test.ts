import { env, fetchMock, createScheduledController, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { runScan } from '../src/scanner';
import { sha256 } from '../src/security';

export const now = new Date('2026-10-24T09:15:00.000Z');
async function task(overrides: Record<string, unknown> = {}) {
  const row = { id: crypto.randomUUID(), name: 'Report <script> & "team"', schedule: '0 9 * * *', timezone: 'UTC', grace_minutes: 15, alert_channel: 'telegram', alert_target: '123', rerun_webhook_url: 'https://hooks.example/run', created_at: '2026-10-24T08:00:00.000Z', paused: 0, ...overrides };
  await env.DB.prepare(`INSERT INTO tasks (id,name,schedule,timezone,grace_minutes,alert_channel,alert_target,rerun_webhook_url,created_at,updated_at,ping_token_hash,paused) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(row.id,row.name,row.schedule,row.timezone,row.grace_minutes,row.alert_channel,row.alert_target,row.rerun_webhook_url,row.created_at,row.created_at,await sha256(row.id),row.paused).run();
  return row;
}
async function heartbeatFetch(request: Request<unknown, IncomingRequestCfProperties>, environment = scanEnv()) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, environment, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
const scanEnv = () => ({ ...env, TELEGRAM_BOT_TOKEN: 'test-telegram-token', RESEND_API_KEY: 'test-resend-key' });
function telegram(check: (body: any) => void = () => {}, status = 200) {
  fetchMock.get('https://api.telegram.org').intercept({ path: '/bottest-telegram-token/sendMessage', method: 'POST' }).reply(status, options => { check(JSON.parse(options.body as string)); return '{}'; });
}
afterEach(() => { vi.useRealTimers(); fetchMock.assertNoPendingInterceptors(); });
it('opens only the latest overdue occurrence, hashes the link token, and sends once', async () => {
  const t = await task();
  expect(await runScan(scanEnv(), new Date(now.getTime() - 1))).toMatchObject({ opened: 0 });
  let url = '';
  telegram(body => { expect(body.chat_id).toBe('123'); expect(body.text).toContain(t.name); expect(body.disable_web_page_preview).toBe(true); url = body.reply_markup.inline_keyboard[0][0].url; });
  expect(await runScan(scanEnv(), now)).toEqual({ checked: 1, opened: 1, errors: 0 });
  const incident = await env.DB.prepare('SELECT * FROM incidents').first<any>();
  const link = new URL(url);
  expect(url).toContain(`${env.PUBLIC_BASE_URL}/rerun/${incident.id}?t=`);
  expect(incident).toMatchObject({ expected_at: '2026-10-24T09:00:00.000Z', alert_status: 'sent', rerun_token_hash: await sha256(link.searchParams.get('t')!) });
  expect(await runScan(scanEnv(), now)).toEqual({ checked: 1, opened: 0, errors: 0 });
});
it('skips paused tasks, tasks created after due and tasks with a heartbeat at due', async () => {
  await task({ paused: 1 }); await task({ created_at: '2026-10-24T09:01:00.000Z' }); const t = await task();
  await env.DB.prepare("INSERT INTO heartbeats (id,task_id,received_at,status) VALUES ('hb',?,?,'fail')").bind(t.id,'2026-10-24T09:00:00.000Z').run();
  expect(await runScan(scanEnv(), now)).toEqual({ checked: 2, opened: 0, errors: 0 });
});
it('delivers escaped email through the scheduled handler', async () => {
  const t = await task({ alert_channel: 'email', alert_target: 'test@example.com' });
  fetchMock.get('https://api.resend.com').intercept({ path: '/emails', method: 'POST', headers: { authorization: 'Bearer test-resend-key' } }).reply(200, options => {
    const body = JSON.parse(options.body as string); expect(body.to).toEqual(['test@example.com']); expect(body.from).toBe(env.ALERT_FROM_EMAIL); expect(body.text).toContain(t.name); expect(body.html).toContain('&lt;script&gt;'); expect(body.html).not.toContain('<script>'); expect(body.html).toContain('Confirm re-run'); return '{}';
  });
  await worker.scheduled(createScheduledController({ scheduledTime: now.getTime() }), scanEnv(), createExecutionContext());
  expect(await env.DB.prepare('SELECT alert_status FROM incidents').first('alert_status')).toBe('sent');
});
it('records missing secrets and continues to other channels', async () => {
  await task(); await task({ alert_channel: 'email', alert_target: 'test@example.com' });
  fetchMock.get('https://api.resend.com').intercept({ path: '/emails', method: 'POST' }).reply(200, '{}');
  expect(await runScan({ ...scanEnv(), TELEGRAM_BOT_TOKEN: undefined }, now)).toMatchObject({ opened: 2 });
  const { results } = await env.DB.prepare('SELECT alert_status,alert_error FROM incidents').all<any>();
  expect(results).toContainEqual({ alert_status: 'failed', alert_error: expect.stringContaining('TELEGRAM_BOT_TOKEN') }); expect(results.some(i => i.alert_status === 'sent')).toBe(true);
});
it('records non-2xx provider responses', async () => {
  await task(); telegram(undefined, 503); await runScan(scanEnv(), now);
  expect(await env.DB.prepare('SELECT alert_status,alert_error FROM incidents').first()).toMatchObject({ alert_status: 'failed', alert_error: expect.stringContaining('503') });
});
it('immediately alerts on failure and sends a late recovery notice', async () => {
  const t = await task(); let url = '';
  telegram(body => { expect(body.text).toContain('reported failure'); expect(body.text).toContain('broken <job>'); expect(body.text).toContain('fail'); url = body.reply_markup.inline_keyboard[0][0].url; });
  const request = new Request<unknown, IncomingRequestCfProperties>(`https://watchdog.test/hb/${t.id}`, { method: 'POST', body: JSON.stringify({ status: 'fail', message: 'broken <job>' }) });
  expect((await heartbeatFetch(request)).status).toBe(200);
  const incident = await env.DB.prepare("SELECT * FROM incidents WHERE kind='failed'").first<any>();
  expect(incident.rerun_token_hash).toBe(await sha256(new URL(url).searchParams.get('t')!));
  await env.DB.prepare("INSERT INTO incidents (id,task_id,kind,expected_at,opened_at) VALUES ('late',?,'missed',?,?)").bind(t.id,'2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z').run();
  telegram(body => { expect(body.text).toContain('recovered: late heartbeat received'); expect(body.reply_markup).toBeUndefined(); });
  telegram(body => { expect(body.text).toContain('recovered: an ok heartbeat was received after a failure'); });
  await heartbeatFetch(new Request(`https://watchdog.test/hb/${t.id}`));
  expect(await env.DB.prepare("SELECT resolution FROM incidents WHERE id='late'").first('resolution')).toBe('late_heartbeat');
});
it('isolates a broken task and scans the remaining task', async () => {
  await task({ timezone: 'Invalid/Zone' }); await task(); telegram();
  expect(await runScan(scanEnv(), now)).toEqual({ checked: 2, opened: 1, errors: 1 });
});
it('checks only the latest occurrence after downtime, in the task timezone', async () => {
  await task({ timezone: 'Asia/Shanghai', created_at: '2020-01-01T00:00:00.000Z' });
  telegram(body => { expect(body.text).toContain('Asia/Shanghai'); expect(body.text).toContain('2026-10-24T01:00:00.000Z'); });
  expect(await runScan(scanEnv(), now)).toMatchObject({ opened: 1 });
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM incidents').first('n')).toBe(1);
});
it('records network failure and omits rerun links without a webhook', async () => {
  await task({ rerun_webhook_url: null });
  fetchMock.get('https://api.telegram.org').intercept({ path: '/bottest-telegram-token/sendMessage', method: 'POST', body: body => { const message = JSON.parse(body); expect(message.reply_markup).toBeUndefined(); expect(message.text).not.toContain('/rerun/'); return true; } }).replyWithError(new Error('network unavailable'));
  await runScan(scanEnv(), now);
  expect(await env.DB.prepare('SELECT alert_status,alert_error FROM incidents').first()).toMatchObject({ alert_status: 'failed', alert_error: expect.any(String) });
});
it('records missing email configuration', async () => {
  await task({ alert_channel: 'email', alert_target: 'test@example.com' });
  await runScan({ ...scanEnv(), RESEND_API_KEY: undefined }, now);
  expect(await env.DB.prepare('SELECT alert_error FROM incidents').first('alert_error')).toContain('RESEND_API_KEY');
});
it.each([
  { original: 503, recovery: 200 },
  { original: 200, recovery: 503 },
])('preserves original alert delivery when recovery responds $recovery', async ({ original, recovery }) => {
  const t = await task({ grace_minutes: 1, created_at: '2020-01-01T08:00:00.000Z' });
  telegram(body => {
    expect(body.text).toContain('Grace: 1 minute\n');
    expect(body.text).not.toContain('1 minutes');
  }, original);
  await runScan(scanEnv(), new Date('2020-01-01T09:15:00.000Z'));
  const before = await env.DB.prepare('SELECT * FROM incidents').first<any>();
  expect(before.recovery_notice_status).toBeNull();
  expect(before.recovery_notice_error).toBeNull();
  telegram(undefined, recovery);
  await heartbeatFetch(new Request(`https://watchdog.test/hb/${t.id}`));
  const after = await env.DB.prepare('SELECT * FROM incidents').first<any>();
  expect(after).toMatchObject({
    alert_status: before.alert_status, alert_error: before.alert_error,
    resolution: 'late_heartbeat',
    recovery_notice_status: recovery === 200 ? 'sent' : 'failed',
    recovery_notice_error: recovery === 200 ? null : 'Alert provider returned HTTP 503',
  });
  // Further heartbeats do not send another recovery notice.
  await heartbeatFetch(new Request(`https://watchdog.test/hb/${t.id}`));
});
it('migration exposes all hardening columns', async () => {
  for (const [table, columns] of Object.entries({
    tasks: ['schedule_anchor_at'], heartbeats: ['dropped_fields'],
    incidents: ['rerun_unknown_alert_status', 'rerun_unknown_alert_error', 'occurrence_count', 'last_occurrence_at', 'last_reminder_at'],
  })) {
    const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all<any>();
    expect(results.map(row => row.name)).toEqual(expect.arrayContaining(columns));
  }
});
it('expires stale requested reruns once even with no active tasks, and a heartbeat resolves them', async () => {
  const t = await task({ paused: 1 });
  await env.DB.prepare("INSERT INTO incidents (id,task_id,kind,expected_at,opened_at,rerun_status,rerun_requested_at) VALUES ('stale',?,'missed',?,?,'requested',?)").bind(t.id, '2020-01-01T09:00:00.000Z', now.toISOString(), new Date(now.getTime()-6*60000).toISOString()).run();
  telegram(body => { expect(body.text).toContain('may already have been delivered'); expect(body.text).toContain('no automatic retry'); expect(body.text).not.toContain('/rerun/'); expect(body.reply_markup).toBeUndefined(); });
  expect(await runScan(scanEnv(), now)).toEqual({ checked: 0, opened: 0, errors: 0 });
  expect(await env.DB.prepare("SELECT * FROM incidents WHERE id='stale'").first()).toMatchObject({ rerun_status: 'unknown', resolved_at: null, rerun_unknown_alert_status: 'sent', rerun_unknown_alert_error: null });
  await runScan(scanEnv(), now);
  telegram();
  await heartbeatFetch(new Request(`https://watchdog.test/hb/${t.id}`));
  expect(await env.DB.prepare("SELECT resolution FROM incidents WHERE id='stale'").first('resolution')).toBe('late_heartbeat');
});
it('leaves a recent request untouched', async () => {
  const t = await task({ paused: 1 });
  await env.DB.prepare("INSERT INTO incidents (id,task_id,kind,expected_at,opened_at,rerun_status,rerun_requested_at) VALUES ('recent',?,'missed',?,?,'requested',?)").bind(t.id, now.toISOString(), now.toISOString(), new Date(now.getTime()-60000).toISOString()).run();
  await runScan(scanEnv(), now);
  expect(await env.DB.prepare("SELECT rerun_status FROM incidents").first('rerun_status')).toBe('requested');
});
it('sends HTTP confirmation links as text without a Telegram button', async () => {
  await task();
  telegram(body => { expect(body.reply_markup).toBeUndefined(); expect(body.text).toContain('http://localhost:8787/rerun/'); });
  await runScan({ ...scanEnv(), PUBLIC_BASE_URL: 'http://localhost:8787' }, now);
  expect(await env.DB.prepare('SELECT alert_status FROM incidents').first('alert_status')).toBe('sent');
});
it.each([200, 503])('retries Telegram button rejection once without markup, final response %s', async status => {
  await task();
  telegram(body => expect(body.reply_markup).toBeDefined(), 400);
  telegram(body => { expect(body.reply_markup).toBeUndefined(); expect(body.text).toContain('https://watchdog.test/rerun/'); }, status);
  await runScan({ ...scanEnv(), PUBLIC_BASE_URL: 'https://watchdog.test' }, now);
  expect(await env.DB.prepare('SELECT alert_status,alert_error FROM incidents').first()).toMatchObject({ alert_status: status === 200 ? 'sent' : 'failed', alert_error: status === 200 ? null : expect.stringContaining('fallback') });
});
it.each([200, 503])('concurrent timeout sweeps attempt one alert and record its final result %s', async status => {
  const t = await task({ paused: 1 });
  await env.DB.prepare("INSERT INTO incidents (id,task_id,kind,expected_at,opened_at,rerun_status,rerun_requested_at) VALUES ('stale',?,'missed',?,?,'requested',?)")
    .bind(t.id, now.toISOString(), now.toISOString(), new Date(now.getTime() - 6*60000).toISOString()).run();
  telegram(undefined, status);
  await Promise.all([runScan(scanEnv(), now), runScan(scanEnv(), now)]);
  expect(await env.DB.prepare("SELECT * FROM incidents WHERE id='stale'").first()).toMatchObject({
    rerun_status: 'unknown', resolved_at: null, alert_status: 'pending', alert_error: null,
    rerun_unknown_alert_status: status === 200 ? 'sent' : 'failed',
    rerun_unknown_alert_error: status === 200 ? null : 'Alert provider returned HTTP 503',
  });
  await runScan(scanEnv(), now);
});
it('returns before slow Telegram completes and deduplicates concurrent runs and open failures', async () => {
  const t = await task({ rerun_webhook_url: null });
  let completed = false;
  fetchMock.get('https://api.telegram.org').intercept({ path: '/bottest-telegram-token/sendMessage', method: 'POST' })
    .reply(200, () => { completed = true; return '{}'; }).delay(300);
  const ctx = createExecutionContext();
  const request = () => new Request<unknown, IncomingRequestCfProperties>(`https://watchdog.test/hb/${t.id}`, { method: 'POST', body: JSON.stringify({ status: 'fail', run_id: 'same' }) });
  const responses = await Promise.all([worker.fetch(request(), scanEnv(), ctx), worker.fetch(request(), scanEnv(), ctx)]);
  expect(responses.map(r => r.status)).toEqual([200, 200]);
  // Delivery is pending when both responses are available.
  expect(await env.DB.prepare('SELECT alert_status FROM incidents').first('alert_status')).toBe('pending');
  const bodies = await Promise.all(responses.map(r => r.json<any>()));
  expect(bodies.filter(b => b.duplicate)).toHaveLength(1);
  expect(bodies[0].received_at).toBe(bodies[1].received_at);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM heartbeats').first('n')).toBe(1);
  await waitOnExecutionContext(ctx);
  expect(completed).toBe(true);
  expect(await env.DB.prepare('SELECT alert_status FROM incidents').first('alert_status')).toBe('sent');
  // No further interceptor: any extra alert would fail delivery and the assertions below.
  for (const body of [{ status: 'fail', run_id: 'other' }, {}, {}]) {
    await heartbeatFetch(new Request(`https://watchdog.test/hb/${t.id}/fail`, { method: 'POST', body: JSON.stringify(body) }));
  }
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM incidents').first('n')).toBe(1);
  expect(await env.DB.prepare('SELECT * FROM incidents').first()).toMatchObject({ occurrence_count: 4, last_occurrence_at: expect.any(String), resolved_at: null, alert_status: 'sent' });
  telegram(body => expect(body.text).toContain('recovered: an ok heartbeat was received after a failure'));
  await heartbeatFetch(new Request(`https://watchdog.test/hb/${t.id}`, { method: 'POST', body: JSON.stringify({ run_id: 'same', status: 'ok' }) }));
  expect(await env.DB.prepare('SELECT * FROM incidents').first()).toMatchObject({ resolution: 'recovered', resolved_at: expect.any(String), recovery_notice_status: 'sent', recovery_notice_error: null });
  const before = await env.DB.prepare('SELECT last_status FROM tasks WHERE id = ?').bind(t.id).first('last_status');
  const duplicate = await heartbeatFetch(request());
  expect(await duplicate.json()).toMatchObject({ duplicate: true });
  expect(await env.DB.prepare('SELECT last_status FROM tasks WHERE id = ?').bind(t.id).first('last_status')).toBe(before);
  // A new failure after recovery opens a fresh incident.
  telegram();
  await heartbeatFetch(new Request(`https://watchdog.test/hb/${t.id}/fail`, { method: 'POST' }));
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM incidents WHERE resolved_at IS NULL').first('n')).toBe(1);
});

async function patchTask(id: string, body: unknown) {
  const response = await heartbeatFetch(new Request(`https://watchdog.test/api/tasks/${id}`, {
    method: 'PATCH', headers: { Authorization: 'Bearer test-admin-token', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
  expect(response.status).toBe(200);
  return (await response.json<any>()).task;
}
it.each(['resume', 'timezone', 'cron'])('anchors %s to the change and alerts only a later occurrence', async mode => {
  const t = await task({ schedule: mode === 'cron' ? '0 0 1 1 *' : '0 9 * * *' });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-24T08:00:00Z'));
  if (mode === 'resume') await patchTask(t.id, { paused: true });
  if (mode === 'resume') expect(await runScan(scanEnv(), now)).toMatchObject({ opened: 0 });
  vi.setSystemTime(new Date('2026-10-24T09:16:30Z'));
  const changed = await patchTask(t.id, mode === 'resume' ? { paused: false } : mode === 'timezone' ? { timezone: 'Asia/Shanghai' } : { schedule: '* * * * *' });
  expect(changed.schedule_anchor_at).toBe('2026-10-24T09:16:30.000Z');
  expect(await runScan(scanEnv(), new Date('2026-10-24T09:31:00Z'))).toMatchObject({ opened: 0 });
  telegram();
  expect(await runScan(scanEnv(), new Date(mode === 'cron' ? '2026-10-24T09:33:00Z' : mode === 'timezone' ? '2026-10-25T01:15:00Z' : '2026-10-25T09:15:00Z'))).toMatchObject({ opened: 1 });
});
it('isolates a directly inserted never-firing schedule', async () => {
  await task({ schedule: '0 0 31 2 *' }); await task(); telegram();
  expect(await runScan(scanEnv(), now)).toEqual({ checked: 2, opened: 1, errors: 1 });
});
it('aggregates consecutive misses, claims backoff reminders once, and starts fresh after a heartbeat', async () => {
  const t = await task({ schedule: '* * * * *', grace_minutes: 1 });
  telegram();
  for (let minute = 0; minute < 30; minute++) await runScan(scanEnv(), new Date(+now + minute * 60000));
  expect(await env.DB.prepare('SELECT * FROM incidents').first()).toMatchObject({ occurrence_count: 30, last_reminder_at: null, alert_status: 'sent' });
  for (const hour of [1, 2, 3, 4, 8, 16, 40, 64]) {
    if (hour !== 3) telegram(body => {
      expect(body.text).toContain('still missing'); expect(body.text).toContain('missed occurrences since');
      expect(body.text).toContain('last expected'); expect(body.text).toContain('heartbeat');
      expect(body.text).not.toContain('/rerun/'); expect(body.reply_markup).toBeUndefined();
    });
    const at = new Date(+now + hour * 3600000);
    await Promise.all([runScan(scanEnv(), at), runScan(scanEnv(), at)]);
    await runScan(scanEnv(), at);
  }
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM incidents').first('n')).toBe(1);
  expect(await env.DB.prepare('SELECT occurrence_count FROM incidents').first('occurrence_count')).toBe(38);
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(+now + 65 * 3600000));
  telegram(); await heartbeatFetch(new Request(`https://watchdog.test/hb/${t.id}`));
  expect(await env.DB.prepare('SELECT resolution FROM incidents').first('resolution')).toBe('late_heartbeat');
  telegram(); await runScan(scanEnv(), new Date(+now + 65 * 3600000 + 120000));
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM incidents').first('n')).toBe(2);
});
it('logs reminder delivery failure without overwriting the original alert status', async () => {
  await task(); telegram(); await runScan(scanEnv(), now);
  telegram(undefined, 503); await runScan(scanEnv(), new Date(+now + 3600000));
  expect(await env.DB.prepare('SELECT alert_status, alert_error, last_reminder_at FROM incidents').first()).toMatchObject({ alert_status: 'sent', alert_error: null, last_reminder_at: new Date(+now + 3600000).toISOString() });
  await runScan(scanEnv(), new Date(+now + 3600000));
});
it('skips resolved incidents in the rerun unknown sweep', async () => {
  const t = await task({ paused: 1 });
  await env.DB.prepare("INSERT INTO incidents (id,task_id,kind,expected_at,opened_at,resolved_at,rerun_status,rerun_requested_at) VALUES ('resolved',?,'missed',?,?,?,'requested',?)")
    .bind(t.id, now.toISOString(), now.toISOString(), now.toISOString(), new Date(+now - 6 * 60000).toISOString()).run();
  expect(await runScan(scanEnv(), now)).toEqual({ checked: 0, opened: 0, errors: 0 });
  expect(await env.DB.prepare('SELECT rerun_status,rerun_unknown_alert_status FROM incidents').first()).toEqual({ rerun_status: 'requested', rerun_unknown_alert_status: null });
});
it.each(['resume', 'timezone', 'cron'])('opens a full alert after %s moves the anchor past an open missed incident', async mode => {
  const t = await task();
  telegram();
  await runScan(scanEnv(), now);
  const old = await env.DB.prepare('SELECT * FROM incidents').first<any>();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-24T09:16:00Z'));
  if (mode === 'resume') await patchTask(t.id, { paused: true });
  vi.setSystemTime(new Date('2026-10-24T09:16:30Z'));
  await patchTask(t.id, mode === 'resume' ? { paused: false } : mode === 'timezone' ? { timezone: 'Asia/Shanghai' } : { schedule: '* * * * *' });
  const at = new Date(mode === 'cron' ? '2026-10-24T09:33:00Z' : mode === 'timezone' ? '2026-10-25T01:15:00Z' : '2026-10-25T09:15:00Z');
  let link = '';
  telegram(body => {
    expect(body.text).not.toContain('still missing');
    link = body.reply_markup.inline_keyboard[0][0].url;
    expect(link).toContain('/rerun/');
  });
  const scans = await Promise.all([runScan(scanEnv(), at), runScan(scanEnv(), at)]);
  expect(scans.reduce((sum, scan) => sum + scan.opened, 0)).toBe(1);
  expect(scans.every(scan => scan.errors === 0)).toBe(true);
  await runScan(scanEnv(), at);
  const { results } = await env.DB.prepare('SELECT * FROM incidents ORDER BY expected_at').all<any>();
  expect(results).toHaveLength(2);
  expect(results[0]).toEqual(old);
  expect(results[1]).toMatchObject({ resolved_at: null, occurrence_count: 1, alert_status: 'sent', rerun_token_hash: await sha256(new URL(link).searchParams.get('t')!) });
  expect(link).toContain(`/rerun/${results[1].id}?t=`);
  // Both open incidents remain recoverable by a heartbeat.
  vi.setSystemTime(at);
  telegram(); telegram();
  await heartbeatFetch(new Request(`https://watchdog.test/hb/${t.id}`));
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM incidents WHERE resolution = 'late_heartbeat'").first('n')).toBe(2);
});
