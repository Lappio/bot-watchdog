import { applyD1Migrations, env, fetchMock } from 'cloudflare:test';
import { afterAll } from 'vitest';

fetchMock.activate();
fetchMock.disableNetConnect();
afterAll(() => fetchMock.deactivate());
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
