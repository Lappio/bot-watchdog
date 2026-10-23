import { env, SELF, createExecutionContext, fetchMock } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { sha256 } from '../src/security';

beforeEach(() => {
  fetchMock.get('https://api.resend.com').intercept({ path: '/emails', method: 'POST' }).reply(200, '{}').persist();
});

const base = 'https://watchdog.test';
const valid = { name: 'Daily report', schedule: '0 9 * * *', timezone: 'Asia/Shanghai', alert_channel: 'email', alert_target: 'me@example.com' };
function api(path = '', method = 'GET', body?: unknown, token = 'test-admin-token') {
  return SELF.fetch(`${base}/api/tasks${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function create(overrides = {}) {
  const response = await api('', 'POST', { ...valid, ...overrides });
  expect(response.status).toBe(201);
  return await response.json<any>();
}
async function ping(token: string, method = 'POST', body?: unknown, suffix = '') {
  return SELF.fetch(`${base}/hb/${token}${suffix}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
}

describe('management', () => {
  it('requires admin auth and fails closed without configuration', async () => {
    expect((await SELF.fetch(`${base}/api/tasks`)).status).toBe(401);
    expect((await api('', 'GET', undefined, 'wrong')).status).toBe(401);
    const response = await worker.fetch(new Request(`${base}/api/tasks`), { ...env, ADMIN_TOKEN: undefined }, createExecutionContext());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'admin_not_configured', message: expect.stringContaining('ADMIN_TOKEN') } });
  });
  it.each([
    { name: '' }, { name: 'x'.repeat(101) }, { schedule: '60 * * * *' }, { schedule: '* * * * * *' },
    { timezone: 'Not/AZone' }, { grace_minutes: 0 }, { grace_minutes: 1441 }, { grace_minutes: 1.5 },
    { alert_channel: 'sms' }, { alert_target: 'invalid' }, { alert_channel: 'telegram', alert_target: 'abc' },
    { rerun_webhook_url: 'http://example.com' }, { rerun_webhook_url: 'javascript:alert(1)' },
    { rerun_webhook_secret: 'x'.repeat(513) }, { rerun_webhook_secret: 1 },
  ])('rejects invalid creation %j', async overrides => {
    const response = await api('', 'POST', { ...valid, ...overrides });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'validation_error', message: expect.any(String) } });
  });
  it('rejects malformed and nonobject JSON', async () => {
    for (const body of ['{', '[]', 'null']) {
      const response = await SELF.fetch(`${base}/api/tasks`, { method: 'POST', headers: { Authorization: 'Bearer test-admin-token' }, body });
      expect(response.status).toBe(400);
    }
  });
  it('creates credentials, hides secrets and ignores unknown fields', async () => {
    const result = await create({ rerun_webhook_url: 'https://example.com/run', rerun_webhook_secret: 'secret', id: 'injected', ping_token_hash: 'injected' });
    expect(result.task.id).toMatch(/^tsk_/);
    expect(result.ping_token).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(result.heartbeat_url).toBe(`${env.PUBLIC_BASE_URL}/hb/${result.ping_token}`);
    expect(result.snippet).toContain(result.heartbeat_url);
    expect(result.task).toMatchObject({ has_rerun_webhook: true, paused: false, grace_minutes: 15 });
    expect(result.task).not.toHaveProperty('ping_token_hash');
    expect(result.task).not.toHaveProperty('rerun_webhook_secret');
    const row = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(result.task.id).first<any>();
    expect(row.ping_token_hash).toBe(await sha256(result.ping_token));
    expect(JSON.stringify(row)).not.toContain(result.ping_token);
  });
  it.each(['-12345', '12345', '@my_channel'])('accepts Telegram target %s and development URL', async target => {
    await create({ alert_channel: 'telegram', alert_target: target, rerun_webhook_url: 'http://127.0.0.1:123/run' });
  });
  it('lists, gets, patches, shows placeholder snippet and cascades deletion', async () => {
    const { task, ping_token } = await create();
    expect((await (await api()).json<any>()).tasks.some((t: any) => t.id === task.id)).toBe(true);
    const detail = await (await api(`/${task.id}`)).json<any>();
    expect(detail).toMatchObject({ task: { id: task.id }, recent_heartbeats: [], open_incidents: [] });
    const patched = await api(`/${task.id}`, 'PATCH', { name: 'Updated', paused: true, unknown: 'ignored' });
    expect(await patched.json()).toMatchObject({ task: { name: 'Updated', paused: true, schedule: valid.schedule } });
    expect((await api(`/${task.id}`, 'PATCH', { paused: 1 })).status).toBe(400);
    const snippet = await api(`/${task.id}/snippet`);
    expect(snippet.headers.get('content-type')).toContain('text/plain');
    const text = await snippet.text();
    for (const value of ['Updated', valid.schedule, valid.timezone, '15 minutes', '<YOUR_PING_TOKEN>', 'curl', '"status":"fail"']) expect(text).toContain(value);
    expect(text).not.toContain(ping_token);
    await ping(ping_token, 'POST', { status: 'fail' });
    expect((await api(`/${task.id}`, 'DELETE')).status).toBe(200);
    expect((await api(`/${task.id}`)).status).toBe(404);
    expect((await ping(ping_token)).status).toBe(404);
    for (const table of ['heartbeats', 'incidents']) expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE task_id = ?`).bind(task.id).first('n')).toBe(0);
  });
  it('lists incidents with authenticated status filtering', async () => {
    const { ping_token } = await create();
    await ping(ping_token, 'POST', undefined, '/fail');
    const fetchIncidents = (query: string) => SELF.fetch(`${base}/api/incidents${query}`, { headers: { Authorization: 'Bearer test-admin-token' } });
    expect((await SELF.fetch(`${base}/api/incidents`)).status).toBe(401);
    expect((await (await fetchIncidents('?status=open')).json<any>()).incidents).toHaveLength(1);
    expect((await (await fetchIncidents('?status=all')).json<any>()).incidents).toHaveLength(1);
    expect((await fetchIncidents('?status=invalid')).status).toBe(400);
  });
  it.each([1, 2])('pluralizes snippet grace of %i minutes', async grace_minutes => {
    const { task, snippet } = await create({ grace_minutes });
    const expected = `Grace: ${grace_minutes} minute${grace_minutes === 1 ? '' : 's'}\n`;
    expect(snippet).toContain(expected);
    expect(await (await api(`/${task.id}/snippet`)).text()).toContain(expected);
  });
  it('rotates tokens and invalidates the original', async () => {
    const result = await create();
    const rotated = await (await api(`/${result.task.id}/rotate-token`, 'POST')).json<any>();
    expect(rotated.ping_token).not.toBe(result.ping_token);
    expect(rotated.snippet).toContain(rotated.heartbeat_url);
    expect((await ping(result.ping_token)).status).toBe(404);
    expect((await ping(rotated.ping_token)).status).toBe(200);
  });
});

describe('heartbeats', () => {
  it('records optional JSON, GET and fail shortcuts, updates task and opens failed incidents', async () => {
    const { task, ping_token } = await create();
    for (const method of ['POST', 'GET']) {
      const response = await ping(ping_token, method);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, task_id: task.id, received_at: expect.any(String) });
    }
    await ping(ping_token, 'POST', { status: 'fail', run_id: 'run', output_url: 'https://example.com/output', message: 'x'.repeat(2100) });
    await ping(ping_token, 'POST', undefined, '/fail');
    const detail = await (await api(`/${task.id}`)).json<any>();
    expect(detail.task.last_status).toBe('fail');
    expect(detail.recent_heartbeats).toHaveLength(4);
    expect(detail.recent_heartbeats.find((hb: any) => hb.run_id === 'run').message).toHaveLength(2000);
    expect(detail.open_incidents.length).toBeGreaterThanOrEqual(1);
    expect(detail.open_incidents.every((i: any) => i.kind === 'failed' && i.expected_at === i.opened_at && i.alert_status === 'sent')).toBe(true);
  });
  it.each([{ status: 'bad' }, { run_id: 'x'.repeat(201) }, { output_url: 'ftp://example.com' }, { output_url: 'https://example.com/' + 'x'.repeat(2000) }, { message: 42 }])('validates heartbeat %j', async body => {
    const { ping_token } = await create();
    expect((await ping(ping_token, 'POST', body)).status).toBe(400);
  });
  it('returns 404 for unknown credentials', async () => { expect((await ping('unknown')).status).toBe(404); });
  it('resolves only eligible missed incidents and retains latest twenty heartbeats', async () => {
    const { task, ping_token } = await create();
    for (const [id, kind, expected] of [['past', 'missed', '2020-01-01T00:00:00.000Z'], ['future', 'missed', '2099-01-01T00:00:00.000Z'], ['failure', 'failed', '2020-01-01T00:00:00.000Z']]) {
      await env.DB.prepare('INSERT INTO incidents (id, task_id, kind, expected_at, opened_at) VALUES (?, ?, ?, ?, ?)').bind(id, task.id, kind, expected, expected).run();
    }
    for (let i = 0; i < 21; i++) await ping(ping_token, 'POST', { run_id: String(i) });
    const detail = await (await api(`/${task.id}`)).json<any>();
    expect(detail.recent_heartbeats).toHaveLength(20);
    expect(detail.recent_heartbeats[0].run_id).toBe('20');
    expect(detail.open_incidents.map((i: any) => i.id).sort()).toEqual(['failure', 'future']);
    expect(await env.DB.prepare('SELECT resolution, resolved_at FROM incidents WHERE id = ?').bind('past').first()).toMatchObject({ resolution: 'late_heartbeat', resolved_at: expect.any(String) });
  });
});
