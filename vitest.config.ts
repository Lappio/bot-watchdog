import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig(async () => ({
  test: {
    setupFiles: ['./test/setup.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          // The defineWorkersConfig-compatible pool bundles this runtime version.
          compatibilityDate: '2026-03-10',
          bindings: { TEST_MIGRATIONS: await readD1Migrations('./migrations') },
        },
      },
    },
  },
}));
