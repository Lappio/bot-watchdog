import { env, SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';

it('returns a healthy response for GET /healthz', async () => {
  const response = await SELF.fetch('https://watchdog.test/healthz');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
});

it('returns a JSON 404 for an unknown path', async () => {
  const response = await SELF.fetch('https://watchdog.test/unknown');
  expect(response.status).toBe(404);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(await response.json()).toEqual({
    error: { code: 'not_found', message: 'Not found' },
  });
});

it('creates all data model tables through D1 migrations', async () => {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('tasks', 'heartbeats', 'incidents') ORDER BY name",
  ).all<{ name: string }>();
  expect(results.map(({ name }) => name)).toEqual(['heartbeats', 'incidents', 'tasks']);
});
