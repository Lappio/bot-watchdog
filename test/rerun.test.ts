import { env, fetchMock, SELF } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { sha256 } from '../src/security';
async function seed(webhook: string | null = 'https://hooks.example/run') {
  await env.DB.prepare(`INSERT INTO tasks (id,name,schedule,alert_channel,alert_target,rerun_webhook_url,rerun_webhook_secret,ping_token_hash,created_at,updated_at) VALUES ('task','<Report> & team','0 9 * * *','telegram','123',?,'secret','hash','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z')`).bind(webhook).run();
  await env.DB.prepare(`INSERT INTO incidents (id,task_id,kind,expected_at,opened_at,rerun_token_hash) VALUES ('inc','task','missed','2026-10-24T09:00:00.000Z','2026-10-24T09:15:00.000Z',?)`).bind(await sha256('token')).run();
}
function post(form = false, token: unknown = 'token', acceptsHtml = false) {
  return SELF.fetch('https://watchdog.test/rerun/inc', { method: 'POST', headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json', ...(acceptsHtml ? { Accept: 'text/html' } : {}) }, body: form ? new URLSearchParams({ t: String(token) }).toString() : JSON.stringify({ t: token }) });
}
function hook(status = 200) {
  fetchMock.get('https://hooks.example').intercept({ path: '/run', method: 'POST', headers: { 'idempotency-key': 'inc', authorization: 'Bearer secret', 'content-type': 'application/json' } }).reply(status, options => {
    expect(JSON.parse(options.body as string)).toEqual({ event: 'bot-watchdog.rerun', task_id: 'task', task_name: '<Report> & team', incident_id: 'inc', expected_at: '2026-10-24T09:00:00.000Z' }); return '{}';
  });
}
afterEach(() => fetchMock.assertNoPendingInterceptors());
it('GET displays escaped details and form without triggering the webhook, with privacy headers', async () => {
  await seed();
  const response = await SELF.fetch('https://watchdog.test/rerun/inc?t=token');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8'); expect(response.headers.get('cache-control')).toBe('no-store'); expect(response.headers.get('x-frame-options')).toBe('DENY'); expect(response.headers.get('referrer-policy')).toBe('no-referrer'); expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  const html = await response.text(); expect(html).toContain('&lt;Report&gt; &amp; team'); expect(html).toContain('2026-10-24T09:00:00.000Z'); expect(html).toContain('method="post"'); expect(html).toContain('Confirm re-run'); expect(html).toContain('name="t" value="token"');
  expect(await env.DB.prepare("SELECT rerun_requested_at FROM incidents WHERE id='inc'").first('rerun_requested_at')).toBeNull();
});
it('rejects bad/missing tokens and returns 404 for unknown incidents', async () => {
  await seed();
  for (const suffix of ['', '?t=wrong']) { const r = await SELF.fetch(`https://watchdog.test/rerun/inc${suffix}`); expect(r.status).toBe(403); expect(r.headers.get('content-type')).toContain('text/html'); }
  expect((await SELF.fetch('https://watchdog.test/rerun/unknown?t=token')).status).toBe(404);
  expect((await post(false,'wrong')).status).toBe(403);
  expect((await post(false, null)).status).toBe(403);
});
it('form confirmation calls webhook once, records success and removes the button', async () => {
  await seed(); hook(); const response = await post(true); expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('text/html'); expect(await response.text()).toContain('succeeded');
  expect(await env.DB.prepare("SELECT rerun_status,rerun_response_code,resolution,resolved_at FROM incidents WHERE id='inc'").first()).toMatchObject({ rerun_status: 'succeeded', rerun_response_code: 200, resolution: 'rerun_ok', resolved_at: expect.any(String) });
  const repeat = await post(); expect(repeat.status).toBe(409); expect(await repeat.json()).toEqual({ ok: false, status: 'succeeded' });
  const page = await (await SELF.fetch('https://watchdog.test/rerun/inc?t=token')).text(); expect(page).toContain('already requested'); expect(page).not.toContain('<button');
});
it('two concurrent confirms make exactly one webhook call', async () => {
  await seed(); hook(); const responses = await Promise.all([post(),post()]); expect(responses.map(r => r.status).sort()).toEqual([200,409]);
  const bodies = await Promise.all(responses.map(r => r.json<any>())); expect(bodies.filter(b => b.ok)).toHaveLength(1); expect(bodies.find(b => !b.ok).status).toMatch(/requested|succeeded/);
});
it('records webhook failure and never retries', async () => {
  await seed(); hook(500); const response = await post(); expect(await response.json()).toEqual({ ok: false, status: 'failed' });
  expect(await env.DB.prepare("SELECT rerun_status,rerun_response_code,rerun_error,resolved_at FROM incidents WHERE id='inc'").first()).toMatchObject({ rerun_status: 'failed', rerun_response_code: 500, rerun_error: expect.stringContaining('500'), resolved_at: null });
  const repeat = await post(false,'token',true); expect(repeat.status).toBe(409); expect(await repeat.text()).toContain('not retried');
});
it('tasks without a webhook have no button and never claim or call', async () => {
  await seed(null); const page = await (await SELF.fetch('https://watchdog.test/rerun/inc?t=token')).text(); expect(page).toContain('No rerun webhook'); expect(page).not.toContain('<button');
  expect((await post()).status).toBe(409); expect(await env.DB.prepare("SELECT rerun_requested_at FROM incidents WHERE id='inc'").first('rerun_requested_at')).toBeNull();
});
it('records network errors and preserves single-shot behavior', async () => {
  await seed(); fetchMock.get('https://hooks.example').intercept({ path: '/run', method: 'POST' }).replyWithError(new Error('connection lost'));
  expect((await post()).status).toBe(502);
  expect(await env.DB.prepare("SELECT rerun_status,rerun_response_code,rerun_error FROM incidents WHERE id='inc'").first()).toMatchObject({ rerun_status: 'failed', rerun_response_code: null, rerun_error: expect.any(String) });
  expect((await post()).status).toBe(409);
});
