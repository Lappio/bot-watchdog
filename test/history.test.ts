import { env, SELF, fetchMock } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { runScan } from '../src/scanner';
import { HISTORY_RETENTION_DAYS } from '../src/history';

const now = new Date('2026-10-24T09:15:00.000Z');
const auth = { Authorization: 'Bearer test-admin-token' };
async function task(paused = true, schedule = '0 9 * * *') {
  const response = await SELF.fetch('https://watchdog.test/api/tasks', { method: 'POST', headers: auth, body: JSON.stringify({ name: '<script>alert("x")</script>', schedule, timezone: 'UTC', paused, alert_channel: 'email', alert_target: 'test@example.com' }) });
  expect(response.status).toBe(201);
  const created = (await response.json<any>()).task;
  if (paused) {
    const patched = await SELF.fetch(`https://watchdog.test/api/tasks/${created.id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ paused: true }) });
    expect(patched.status).toBe(200);
  }
  return created;
}
async function get(path: string, headers: Record<string, string> = auth) { return SELF.fetch(`https://watchdog.test${path}`, { headers }); }
async function heartbeat(id: string, at: string, taskId: string) {
  await env.DB.prepare("INSERT INTO heartbeats (id,task_id,received_at,status,message) VALUES (?,?,?,'ok','<img src=x onerror=alert(1)>')").bind(id, taskId, at).run();
}
async function incident(id: string, taskId: string, at: string, resolved: string | null = null) {
  await env.DB.prepare("INSERT INTO incidents (id,task_id,kind,expected_at,opened_at,resolved_at) VALUES (?,?,'missed',?,?,?)").bind(id, taskId, at, at, resolved).run();
}
it('paginates runs and includes incidents in each page time window', async () => {
  const t = await task();
  for (let n = 1; n <= 5; n++) await heartbeat(`hb${n}`, `2026-10-24T09:0${n}:00.000Z`, t.id);
  await incident('inside', t.id, '2026-10-24T09:04:30.000Z');
  await incident('outside', t.id, '2026-10-24T08:00:00.000Z');
  let before = '';
  const ids: string[] = [];
  for (let page = 0; page < 4; page++) {
    const response = await get(`/api/tasks/${t.id}/runs?limit=2${before ? `&before=${before}` : ''}`);
    expect(response.status).toBe(200);
    const body = await response.json<any>();
    if (page === 0) expect(body.incidents.map((i: any) => i.id)).toEqual(['inside']);
    ids.push(...body.runs.map((r: any) => r.id));
    before = body.next_before;
    if (page === 3) expect(body).toMatchObject({ runs: [], next_before: null, incidents: [] });
  }
  expect(ids).toEqual(['hb5', 'hb4', 'hb3', 'hb2', 'hb1']);
  expect((await get(`/api/tasks/${t.id}/runs?before=invalid`)).status).toBe(400);
  expect((await get('/api/tasks/missing/runs')).status).toBe(404);
  expect((await get(`/api/tasks/${t.id}/runs`, {})).status).toBe(401);
  expect((await (await get(`/api/tasks/${t.id}/runs?limit=0`)).json<any>()).runs).toHaveLength(1);
});
it('lists paused schedules, computed next runs, public fields, and open incidents', async () => {
  const t = await task();
  await incident('open', t.id, now.toISOString());
  await incident('closed', t.id, '2026-10-23T09:15:00.000Z', now.toISOString());
  const active = await task(false, '* * * * *');
  const body = await (await get('/api/schedule')).json<any>();
  expect(body.tasks).toHaveLength(2);
  const paused = body.tasks.find((row: any) => row.id === t.id);
  expect(paused).toMatchObject({ paused: true, next_run: expect.any(String), schedule_anchor_at: expect.any(String), created_at: expect.any(String), open_incidents: [{ id: 'open', kind: 'missed', alert_status: 'pending', expected_at: now.toISOString(), opened_at: now.toISOString() }] });
  expect(paused.ping_token_hash).toBeUndefined();
  expect(paused.alert_target).toBeUndefined();
  expect(Date.parse(body.tasks[0].next_run)).toBeLessThanOrEqual(Date.parse(body.tasks[1].next_run));
  expect(body.tasks.find((row: any) => row.id === active.id).paused).toBe(false);
  expect((await get('/api/schedule', {})).status).toBe(401);
});
it('prunes only expired history and resolved incidents, including scans with no active tasks', async () => {
  expect(HISTORY_RETENTION_DAYS).toBe(90);
  const t = await task();
  const cutoff = new Date(+now - 90 * 86400000).toISOString();
  const old = new Date(Date.parse(cutoff) - 1).toISOString();
  await heartbeat('old', old, t.id);
  await heartbeat('boundary', cutoff, t.id);
  await heartbeat('recent', now.toISOString(), t.id);
  await incident('old-open', t.id, old);
  await incident('old-closed', t.id, '2020-01-01T00:00:00.000Z', old);
  await incident('recent-closed', t.id, '2020-01-02T00:00:00.000Z', now.toISOString());
  for (const [id, at] of [['old', old], ['boundary', cutoff], ['recent', now.toISOString()]]) {
    await env.DB.prepare("INSERT INTO scan_events (id,task_id,at,kind) VALUES (?,?,?,'scan_error')").bind(id, t.id, at).run();
  }
  expect(await runScan(env, now)).toMatchObject({ checked: 0, errors: 0 });
  expect((await env.DB.prepare('SELECT id FROM heartbeats ORDER BY id').all()).results).toEqual([{ id: 'boundary' }, { id: 'recent' }]);
  expect((await env.DB.prepare('SELECT id FROM scan_events ORDER BY id').all()).results).toEqual([{ id: 'boundary' }, { id: 'recent' }]);
  expect((await env.DB.prepare('SELECT id FROM incidents ORDER BY id').all()).results).toEqual([{ id: 'old-open' }, { id: 'recent-closed' }]);
});
it('serves escaped HTML with admin auth and security headers', async () => {
  const t = await task();
  await heartbeat('xss', now.toISOString(), t.id);
  for (const path of ['/admin/schedule', `/admin/tasks/${t.id}/history`]) {
    for (const headers of [{}, { Authorization: 'Bearer wrong' }] as Record<string, string>[]) {
      const response = await get(path, headers);
      expect(response.status).toBe(401);
      expect(response.headers.get('Content-Type')).toContain('text/html');
    }
    const response = await get(path);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const text = await response.text();
    expect(text).toContain('&lt;script&gt;');
    expect(text).not.toContain('<script>');
    expect(text).not.toContain('<img');
  }
  const missing = await get('/admin/tasks/missing/history');
  expect(missing.status).toBe(404);
  expect(missing.headers.get('Content-Type')).toContain('text/html');
});
it('records missed opening, successful reminder, rerun unknown and task scan errors', async () => {
  const t = await task(false);
  await env.DB.prepare('UPDATE tasks SET created_at = ?, schedule_anchor_at = ? WHERE id = ?').bind('2026-10-24T08:00:00.000Z', '2026-10-24T08:00:00.000Z', t.id).run();
  fetchMock.get('https://api.resend.com').intercept({ path: '/emails', method: 'POST' }).reply(200, '{}').persist();
  await runScan(env, now);
  const opened = await env.DB.prepare("SELECT * FROM scan_events WHERE kind = 'scan_opened_missed'").first<any>();
  expect(opened).toMatchObject({ task_id: t.id, at: now.toISOString(), ref_id: expect.any(String) });
  await runScan(env, new Date(+now + 3600000));
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM scan_events WHERE kind = 'scan_reminder'").first('n')).toBe(1);
  await env.DB.prepare("UPDATE incidents SET rerun_status='requested',rerun_requested_at=? WHERE id=?").bind(now.toISOString(), opened.ref_id).run();
  await env.DB.prepare("UPDATE tasks SET paused=1 WHERE id=?").bind(t.id).run();
  await runScan(env, new Date(+now + 3600000));
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM scan_events WHERE kind = 'rerun_unknown'").first('n')).toBe(1);
  await env.DB.prepare("UPDATE tasks SET paused=0,schedule='invalid' WHERE id=?").bind(t.id).run();
  await runScan(env, now);
  expect(await env.DB.prepare("SELECT detail FROM scan_events WHERE kind='scan_error'").first('detail')).toBe('Schedule cannot be evaluated');
});

it('continues scanning when event inserts fail', async () => {
  const t = await task(false);
  await env.DB.prepare('UPDATE tasks SET created_at = ?, schedule_anchor_at = ? WHERE id = ?').bind('2026-10-24T08:00:00.000Z', '2026-10-24T08:00:00.000Z', t.id).run();
  await env.DB.exec("CREATE TRIGGER reject_scan_events BEFORE INSERT ON scan_events BEGIN SELECT RAISE(FAIL, 'event store unavailable'); END");
  fetchMock.get('https://api.resend.com').intercept({ path: '/emails', method: 'POST' }).reply(200, '{}');
  expect(await runScan(env, now)).toMatchObject({ checked: 1, opened: 1, errors: 0 });
  expect(await env.DB.prepare('SELECT alert_status FROM incidents').first('alert_status')).toBe('sent');
});
