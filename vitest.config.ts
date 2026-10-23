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
          bindings: { ADMIN_TOKEN: 'test-admin-token', TELEGRAM_BOT_TOKEN: 'test-telegram-token', RESEND_API_KEY: 'test-resend-key', TEST_MIGRATIONS: await readD1Migrations('./migrations') },
        },
      },
    },
  },
}));
