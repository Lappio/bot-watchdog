import type { Env } from './env';
import { runScan } from './scanner';

export default {
  async fetch(request, _env, _ctx): Promise<Response> {
    if (request.method === 'GET' && new URL(request.url).pathname === '/healthz') {
      return Response.json({ ok: true });
    }
    return Response.json(
      { error: { code: 'not_found', message: 'Not found' } },
      { status: 404 },
    );
  },
  async scheduled(controller, env, _ctx): Promise<void> {
    await runScan(env, new Date(controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
