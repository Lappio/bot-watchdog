import { env, fetchMock, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import worker from '../src/index';
import { checkDeliverable as http } from '../src/deliverable/http';
import { checkDeliverable as github } from '../src/deliverable/github';
import { checkDeliverable as slack } from '../src/deliverable/slack';
import { checkDeliverable as email } from '../src/deliverable/email';
import { runScan } from '../src/scanner';

const base = 'https://watchdog.test';
const valid = { name: 'Deliverable', schedule: '0 9 * * *', alert_channel: 'email', alert_target: 'me@example.com' };
async function api(path: string, method = 'GET', body?: unknown) {
  return worker.fetch(new Request(`${base}/api/${path}`, { method, headers: { Authorization: 'Bearer test-admin-token', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env, createExecutionContext());
}
async function create(extra = {}) {
  const response = await api('tasks', 'POST', { ...valid, deliverable_check: 'http', deliverable_delay_minutes: 0, ...extra });
  expect(response.status).toBe(201);
  return response.json<any>();
}
async function ping(token: string, status = 'ok', run_id = 'run-1') {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${base}/hb/${token}`, { method: 'POST', body: JSON.stringify({ status, run_id, output_url: 'https://output.test/report' }) }), env, ctx);
  await waitOnExecutionContext(ctx);
  return response.json<any>();
}
afterEach(() => fetchMock.assertNoPendingInterceptors());

it.each([
  [200, {}, 'hello', true], [201, {}, '', true], [302, {}, '', false], [404, {}, '', false],
  [201, { expect_status: 200 }, '', false], [202, { expect_status: 202 }, '', true],
  [200, { expect_contains: 'hello' }, 'hello world', true], [200, { expect_contains: 'missing' }, 'hello', false],
  [200, { expect_contains: 'needle' }, 'x'.repeat(65536) + 'needle', false],
] as const)('http status/content %i %j', async (status, config, body, ok) => {
  fetchMock.get('https://output.test').intercept({ path: '/report' }).reply(status, body);
  expect(await http(config, { output_url: 'https://output.test/report' })).toMatchObject({ ok });
});
it('http uses configured url over heartbeat and reports missing URLs', async () => {
  expect(await http({}, { output_url: null })).toEqual({ ok: false, detail: 'no url' });
  fetchMock.get('https://override.test').intercept({ path: '/file' }).reply(200, '');
  expect(await http({ url: 'https://override.test/file' }, { output_url: 'https://output.test/report' })).toMatchObject({ ok: true });
});
it('http converts network failures to failed results', async () => {
  fetchMock.get('https://output.test').intercept({ path: '/report' }).replyWithError(new Error('offline'));
  expect(await http({}, { output_url: 'https://output.test/report' })).toMatchObject({ ok: false });
});
it.each([
  [{ type: 'commit', sha: 'abc' }, '/repos/org/repo/commits/abc'],
  [{ type: 'commit', ref: 'feature/x' }, '/repos/org/repo/commits/feature%2Fx'],
  [{ type: 'pr', number: 12 }, '/repos/org/repo/pulls/12'],
  [{ type: 'issue', number: 7 }, '/repos/org/repo/issues/7'],
  [{ type: 'file', path: 'reports/a b.txt', ref: 'main' }, '/repos/org/repo/contents/reports/a%20b.txt?ref=main'],
  [{ type: 'url', url: 'https://api.github.com/custom' }, '/custom'],
] as const)('github maps %j and sends API headers', async (config, path) => {
  fetchMock.get('https://api.github.com').intercept({ path, headers: {
    authorization: 'Bearer test-pat', accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'bot-watchdog',
  } }).reply(200, '{}');
  expect(await github({ ...env, GITHUB_TOKEN: 'test-pat' }, { owner: 'org', repo: 'repo', ...config })).toEqual({ ok: true, detail: 'GitHub HTTP 200' });
});
it.each([404, 403, 500])('github fails on HTTP %i', async status => {
  fetchMock.get('https://api.github.com').intercept({ path: '/repos/org/repo/commits/HEAD' }).reply(status, '{}');
  expect(await github({ ...env, GITHUB_TOKEN: 'test-pat' }, { type: 'commit', owner: 'org', repo: 'repo' })).toEqual({ ok: false, detail: `GitHub HTTP ${status}` });
});
it('github requires a token; slack and email are explicit stubs', async () => {
  expect(await github({ ...env, GITHUB_TOKEN: undefined }, {})).toEqual({ ok: false, detail: 'GITHUB_TOKEN is not configured' });
  expect(await slack()).toEqual({ ok: false, detail: 'not_implemented' });
  expect(await email()).toEqual({ ok: false, detail: 'not_implemented' });
});
it.each([200, 404])('schedules one check per ok run and scanner records HTTP %i', async status => {
  const { task, ping_token } = await create();
  const first = await ping(ping_token);
  expect(await ping(ping_token)).toMatchObject({ duplicate: true });
  const checks = await env.DB.prepare('SELECT * FROM deliverable_checks').all<any>();
  expect(checks.results).toHaveLength(1);
  expect(checks.results[0]).toMatchObject({ due_at: first.received_at, status: 'pending', attempts: 0 });
  fetchMock.get('https://output.test').intercept({ path: '/report' }).reply(status, '');
  if (status === 404) fetchMock.get('https://api.resend.com').intercept({ path: '/emails', method: 'POST' }).reply(200, options => {
    expect(JSON.parse(options.body as string).text).toContain('deliverable missing');
    expect(JSON.parse(options.body as string).text).toContain('HTTP 404');
    return '{}';
  });
  const now = new Date(Date.parse(first.received_at) + 1000);
  // Two overlapping sweeps must fetch and alert only once.
  await Promise.all([runScan(env, now), runScan(env, now)]);
  expect(await env.DB.prepare('SELECT status FROM deliverable_checks').first('status')).toBe(status === 200 ? 'passed' : 'failed');
  expect(await env.DB.prepare('SELECT attempts FROM deliverable_checks').first('attempts')).toBe(1);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM incidents WHERE kind='deliverable_missing'").first('n')).toBe(status === 200 ? 0 : 1);
  expect(await env.DB.prepare('SELECT kind FROM scan_events').first('kind')).toBe(status === 200 ? 'scan_deliverable_passed' : 'scan_deliverable_failed');
  if (status === 404) {
    expect(await env.DB.prepare('SELECT expected_at FROM incidents').first('expected_at')).toBe(first.received_at);
    fetchMock.get('https://api.resend.com').intercept({ path: '/emails', method: 'POST' }).reply(200, '{}');
    await ping(ping_token, 'ok', 'next-run');
    expect(await env.DB.prepare('SELECT resolution FROM incidents').first('resolution')).toBe('recovered');
  }
  await api(`tasks/${task.id}`, 'DELETE');
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM deliverable_checks').first('n')).toBe(0);
});
it('fails interrupted claimed checks after two minutes and alerts only once', async () => {
  const { task, ping_token } = await create();
  const hb = await ping(ping_token);
  const now = new Date(hb.received_at);
  await env.DB.prepare('UPDATE deliverable_checks SET attempts = 1, due_at = ?')
    .bind(new Date(now.getTime() - 60000).toISOString()).run();
  await runScan(env, now);
  expect(await env.DB.prepare('SELECT status FROM deliverable_checks').first('status')).toBe('pending');
  await env.DB.prepare('UPDATE deliverable_checks SET due_at = ?')
    .bind(new Date(now.getTime() - 180000).toISOString()).run();
  let alerts = 0;
  fetchMock.get('https://api.resend.com').intercept({ path: '/emails', method: 'POST' }).reply(200, options => {
    alerts++;
    const text = JSON.parse(options.body as string).text;
    expect(text).toContain('deliverable missing');
    expect(text).toContain('check interrupted');
    return '{}';
  });
  await Promise.all([runScan(env, now), runScan(env, now)]);
  const check = await env.DB.prepare('SELECT * FROM deliverable_checks').first<any>();
  expect(check).toMatchObject({ status: 'failed', result_detail: 'check interrupted', attempts: 1, finished_at: now.toISOString() });
  expect(await env.DB.prepare("SELECT * FROM incidents WHERE kind = 'deliverable_missing'").all()).toMatchObject({
    results: [expect.objectContaining({ id: check.opened_incident_id, task_id: task.id, expected_at: hb.received_at, alert_status: 'sent' })],
  });
  await runScan(env, new Date(now.getTime() + 60000));
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM incidents WHERE kind = 'deliverable_missing'").first('n')).toBe(1);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM scan_events WHERE kind = 'scan_deliverable_failed'").first('n')).toBe(1);
  expect(alerts).toBe(1);
});
it('does not schedule on fail; applies delay and skips checks when disabled', async () => {
  const { task, ping_token } = await create({ deliverable_delay_minutes: 5 });
  fetchMock.get('https://api.resend.com').intercept({ path: '/emails', method: 'POST' }).reply(200, '{}');
  await ping(ping_token, 'fail');
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM deliverable_checks').first('n')).toBe(0);
  fetchMock.get('https://api.resend.com').intercept({ path: '/emails', method: 'POST' }).reply(200, '{}');
  const ok = await ping(ping_token);
  const due = await env.DB.prepare('SELECT due_at FROM deliverable_checks').first<string>('due_at');
  expect(Date.parse(due!) - Date.parse(ok.received_at)).toBe(300000);
  await runScan(env, new Date(ok.received_at));
  expect(await env.DB.prepare('SELECT attempts FROM deliverable_checks').first('attempts')).toBe(0);
  await api(`tasks/${task.id}`, 'PATCH', { deliverable_check: 'none' });
  await runScan(env, new Date(due!));
  expect(await env.DB.prepare('SELECT status FROM deliverable_checks').first('status')).toBe('skipped');
});
it('a passed check resolves an open deliverable incident for the same expected time', async () => {
  const { task, ping_token } = await create();
  const hb = await ping(ping_token);
  await env.DB.prepare("INSERT INTO incidents (id,task_id,kind,expected_at,opened_at) VALUES ('previous',?,'deliverable_missing',?,?)").bind(task.id, hb.received_at, hb.received_at).run();
  fetchMock.get('https://output.test').intercept({ path: '/report' }).reply(200, '');
  await runScan(env, new Date(Date.parse(hb.received_at) + 1000));
  expect(await env.DB.prepare("SELECT resolution FROM incidents WHERE id='previous'").first('resolution')).toBe('deliverable_ok');
});
it('creates and patches deliverable fields with parsed public configuration', async () => {
  const { task } = await create({ deliverable_config: JSON.stringify({ expect_contains: 'ready', unknown: 'ignored by checker' }) });
  expect(task).toMatchObject({ deliverable_check: 'http', deliverable_delay_minutes: 0, deliverable_config: { expect_contains: 'ready' } });
  const response = await api(`tasks/${task.id}`, 'PATCH', { deliverable_check: 'github', deliverable_config: { type: 'commit', owner: 'org', repo: 'repo' }, deliverable_delay_minutes: 1440 });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ task: { deliverable_check: 'github', deliverable_config: { type: 'commit', owner: 'org' }, deliverable_delay_minutes: 1440 } });
  expect(await (await api(`tasks/${task.id}`)).json()).toMatchObject({ task: { deliverable_check: 'github' } });
  expect(await (await api('schedule')).json()).toMatchObject({ tasks: [expect.objectContaining({ deliverable_check: 'github' })] });
  expect((await api(`tasks/${task.id}`, 'PATCH', { name: 'rename' })).status).toBe(200);
});
it.each([
  { deliverable_check: 'slack' }, { deliverable_delay_minutes: -1 }, { deliverable_delay_minutes: 1441 }, { deliverable_delay_minutes: 1.5 },
  { deliverable_config: '{' }, { deliverable_config: [] }, { deliverable_config: 'null' },
  { deliverable_config: { url: 'ftp://example.com' } }, { deliverable_config: { expect_status: '200' } },
  { deliverable_config: { expect_contains: 'x'.repeat(501) } },
  { deliverable_check: 'github', deliverable_config: { type: 'commit' } },
  { deliverable_check: 'github', deliverable_config: { type: 'bad', owner: 'o', repo: 'r' } },
  { deliverable_check: 'github', deliverable_config: { type: 'url' } },
])('rejects invalid deliverable input on create and patch %j', async invalid => {
  expect((await api('tasks', 'POST', { ...valid, deliverable_check: 'http', ...invalid })).status).toBe(400);
  const { task } = await create();
  expect((await api(`tasks/${task.id}`, 'PATCH', invalid)).status).toBe(400);
});
