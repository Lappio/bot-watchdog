import { env, fetchMock, createScheduledController, createExecutionContext } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import worker from '../src/index';
import { runScan } from '../src/scanner';
import { sha256 } from '../src/security';

export const now = new Date('2026-10-24T09:15:00.000Z');
async function task(overrides: Record<string, unknown> = {}) {
  const row = { id: crypto.randomUUID(), name: 'Report <script> & "team"', schedule: '0 9 * * *', timezone: 'UTC', grace_minutes: 15, alert_channel: 'telegram', alert_target: '123', rerun_webhook_url: 'https://hooks.example/run', created_at: '2026-10-24T08:00:00.000Z', paused: 0, ...overrides };
  await env.DB.prepare(`INSERT INTO tasks (id,name,schedule,timezone,grace_minutes,alert_channel,alert_target,rerun_webhook_url,created_at,updated_at,ping_token_hash,paused) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(row.id,row.name,row.schedule,row.timezone,row.grace_minutes,row.alert_channel,row.alert_target,row.rerun_webhook_url,row.created_at,row.created_at,await sha256(row.id),row.paused).run();
  return row;
}
const scanEnv = () => ({ ...env, TELEGRAM_BOT_TOKEN: 'test-telegram-token', RESEND_API_KEY: 'test-resend-key' });
function telegram(check: (body: any) => void = () => {}, status = 200) {
  fetchMock.get('https://api.telegram.org').intercept({ path: '/bottest-telegram-token/sendMessage', method: 'POST' }).reply(status, options => { check(JSON.parse(options.body as string)); return '{}'; });
}
afterEach(() => fetchMock.assertNoPendingInterceptors());
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
  expect((await worker.fetch(request, scanEnv(), createExecutionContext())).status).toBe(200);
  const incident = await env.DB.prepare("SELECT * FROM incidents WHERE kind='failed'").first<any>();
  expect(incident.rerun_token_hash).toBe(await sha256(new URL(url).searchParams.get('t')!));
  await env.DB.prepare("INSERT INTO incidents (id,task_id,kind,expected_at,opened_at) VALUES ('late',?,'missed',?,?)").bind(t.id,'2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z').run();
  telegram(body => { expect(body.text).toContain('recovered: late heartbeat received'); expect(body.reply_markup).toBeUndefined(); });
  await worker.fetch(new Request(`https://watchdog.test/hb/${t.id}`), scanEnv(), createExecutionContext());
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
  await worker.fetch(new Request(`https://watchdog.test/hb/${t.id}`), scanEnv(), createExecutionContext());
  const after = await env.DB.prepare('SELECT * FROM incidents').first<any>();
  expect(after).toMatchObject({
    alert_status: before.alert_status, alert_error: before.alert_error,
    resolution: 'late_heartbeat',
    recovery_notice_status: recovery === 200 ? 'sent' : 'failed',
    recovery_notice_error: recovery === 200 ? null : 'Alert provider returned HTTP 503',
  });
  // Further heartbeats do not send another recovery notice.
  await worker.fetch(new Request(`https://watchdog.test/hb/${t.id}`), scanEnv(), createExecutionContext());
});
