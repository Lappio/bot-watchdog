import { env, SELF, fetchMock } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { stats } from '../src/stats';
const headers = { Authorization: 'Bearer test-admin-token', 'Content-Type': 'application/json' };
const api = (path: string, method = 'GET', body?: unknown) => SELF.fetch(`https://watchdog.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
async function task(bot: unknown = ' Agent ') {
  const r = await api('/api/tasks', 'POST', { name: 'Report', bot, schedule: '0 9 * * *', alert_channel: 'email', alert_target: 'me@example.com', rerun_webhook_url: 'https://hooks.example/run', rerun_webhook_secret: 'secret' });
  expect(r.status).toBe(201); return (await r.json<any>()).task;
}
async function incident(taskId: string, id = 'inc', resolved = false) {
  await env.DB.prepare(`INSERT INTO incidents (id,task_id,kind,expected_at,opened_at,rerun_token_hash,resolved_at) VALUES (?,?,'missed',?,'2026-10-23T00:00:00.000Z','private-hash',?)`).bind(id, taskId, id === 'b' || id === 'second' ? '2026-10-23T01:00:00.000Z' : '2026-10-23T00:00:00.000Z', resolved ? '2026-10-24T00:00:00.000Z' : null).run();
}
it('trims bot, preserves omitted patches, clears empty/null, exposes schedule and escapes HTML', async () => {
  const t = await task(' <Agent> '); expect(t.bot).toBe('<Agent>');
  expect((await (await api(`/api/tasks/${t.id}`, 'PATCH', { name: 'Renamed' })).json<any>()).task.bot).toBe('<Agent>');
  expect((await (await api('/api/schedule')).json<any>()).tasks[0].bot).toBe('<Agent>');
  const html = await (await api('/admin/schedule')).text(); expect(html).toContain('<th>Bot</th>'); expect(html).toContain('&lt;Agent&gt;');
  for (const bot of ['', '   ', null]) expect((await (await api(`/api/tasks/${t.id}`, 'PATCH', { bot })).json<any>()).task.bot).toBeNull();
  for (const bot of [12, {}, 'x'.repeat(101)]) {
    expect((await api(`/api/tasks/${t.id}`, 'PATCH', { bot })).status).toBe(400);
    expect((await api('/api/tasks', 'POST', { name: 'x', schedule: '* * * * *', alert_channel: 'email', alert_target: 'a@b.com', bot })).status).toBe(400);
  }
  expect((await task('x'.repeat(100))).bot).toHaveLength(100);
});
it('filters and limits incidents, joins task labels and strips token hashes from every incident JSON view', async () => {
  const a = await task(), b = await task(null); await incident(a.id, 'a'); await incident(a.id, 'b', true); await incident(b.id, 'c');
  const rows = (await (await api(`/api/incidents?status=all&task_id=${a.id}&limit=1`)).json<any>()).incidents;
  expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ task_id: a.id, task_name: 'Report', task_bot: 'Agent' }); expect(rows[0]).not.toHaveProperty('rerun_token_hash');
  expect((await (await api(`/api/incidents?task_id=${a.id}`)).json<any>()).incidents).toHaveLength(1);
  for (const path of ['/api/incidents?status=all', `/api/tasks/${a.id}`]) expect(await (await api(path)).text()).not.toContain('private-hash');
  await env.DB.prepare("INSERT INTO heartbeats (id,task_id,received_at,status) VALUES ('h',?,'2026-10-23T00:00:00.000Z','ok')").bind(a.id).run();
  expect(await (await api(`/api/tasks/${a.id}/runs`)).text()).not.toContain('private-hash');
  for (const limit of ['0', '501', '1.5', 'abc', '']) expect((await api(`/api/incidents?limit=${limit}`)).status).toBe(400);
});
it('aggregates UTC stats with zero fill and an inclusive rolling 24h window', async () => {
  const a = await task(), b = await task(), c = await task(), d = await task();
  await env.DB.prepare("UPDATE tasks SET paused=1 WHERE id=?").bind(b.id).run();
  await env.DB.prepare("UPDATE tasks SET last_status='fail' WHERE id=?").bind(c.id).run();
  await incident(d.id); await incident(d.id, 'second');
  for (const [id, time, status] of [['old','2026-10-23T11:59:59.999Z','fail'],['edge','2026-10-23T12:00:00.000Z','fail'],['today','2026-10-24T10:00:00.000Z','ok'],['future','2026-10-24T13:00:00.000Z','fail']]) await env.DB.prepare('INSERT INTO heartbeats (id,task_id,received_at,status) VALUES (?,?,?,?)').bind(id,a.id,time,status).run();
  const response = await stats(new Request('https://watchdog.test/api/stats?days=3'), env, new Date('2026-10-24T12:00:00.000Z'));
  expect(await response.json()).toEqual({ generated_at: '2026-10-24T12:00:00.000Z', totals: { tasks: 4, active: 3, paused: 1, healthy: 1, with_open_incidents: 1, open_incidents: 2, heartbeats_24h: 2, failed_heartbeats_24h: 1 }, series: [{ date:'2026-10-22',ok:0,fail:0,incidents_opened:0 },{ date:'2026-10-23',ok:0,fail:2,incidents_opened:2 },{ date:'2026-10-24',ok:1,fail:0,incidents_opened:0 }] });
});
it('validates stats days, defaults to 14 and supports 1 and 90 days with empty totals', async () => {
  for (const days of ['0','91','1.2','no','']) expect((await api(`/api/stats?days=${days}`)).status).toBe(400);
  for (const days of [14,1,90]) {
    const body = await (await api(`/api/stats${days === 14 ? '' : `?days=${days}`}`)).json<any>();
    expect(body.series).toHaveLength(days); expect(Object.values(body.totals).every(n => n === 0)).toBe(true);
  }
});
it('admin rerun succeeds once under concurrent POSTs and hides hash', async () => {
  const t = await task(); await incident(t.id);
  fetchMock.get('https://hooks.example').intercept({ path:'/run',method:'POST',headers:{'idempotency-key':'inc',authorization:'Bearer secret'} }).reply(200,'{}');
  const responses = await Promise.all([api('/api/incidents/inc/rerun','POST'),api('/api/incidents/inc/rerun','POST')]);
  expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
  const success = await responses.find(r=>r.status===200)!.json<any>(); expect(success).toMatchObject({ok:true,status:'succeeded',incident:{resolution:'rerun_ok',rerun_response_code:200}}); expect(success.incident).not.toHaveProperty('rerun_token_hash');
  expect((await api('/api/incidents/inc/rerun','POST')).status).toBe(409); fetchMock.assertNoPendingInterceptors();
});
it('admin rerun blocks resolved, unknown, previously requested and missing webhook without calls', async () => {
  const t = await task(); await incident(t.id);
  for (const update of ["resolved_at='2026-10-24T00:00:00.000Z'", "resolved_at=NULL,rerun_status='unknown'", "rerun_status='requested',rerun_requested_at='2026-10-24T00:00:00.000Z'"]) {
    await env.DB.prepare(`UPDATE incidents SET ${update} WHERE id='inc'`).run(); expect((await api('/api/incidents/inc/rerun','POST')).status).toBe(409);
  }
  await env.DB.prepare("UPDATE incidents SET rerun_status='none',rerun_requested_at=NULL WHERE id='inc'").run(); await env.DB.prepare('UPDATE tasks SET rerun_webhook_url=NULL').run(); expect((await api('/api/incidents/inc/rerun','POST')).status).toBe(409);
});
it('requires admin for new endpoints and redirects dashboard entry points', async () => {
  for (const [path,method] of [['/api/stats','GET'],['/api/incidents','GET'],['/api/incidents/inc/rerun','POST']]) expect((await SELF.fetch(`https://watchdog.test${path}`,{method})).status).toBe(401);
  for (const path of ['/','/dashboard']) { const r=await api(path); expect(r.status).toBe(302);expect(r.headers.get('location')).toBe('https://watchdog.test/dashboard/'); }
});
