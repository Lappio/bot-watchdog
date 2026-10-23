import type { Env } from './env';
import { runScan } from './scanner';
import { management } from './api';
import { rerun } from './rerun';
import { heartbeat } from './heartbeat';
import { HttpError, jsonError } from './http';
import { requireAdmin } from './security';

export default {
  async fetch(request, env, _ctx): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === '/healthz') return Response.json({ ok: true });
      if (path === '/api/incidents') {
        await requireAdmin(request, env.ADMIN_TOKEN);
        if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
        const status = new URL(request.url).searchParams.get('status') ?? 'open';
        if (status !== 'open' && status !== 'all') throw new HttpError(400, 'validation_error', 'status must be open or all');
        const { results } = await env.DB.prepare(`SELECT * FROM incidents ${status === 'open' ? 'WHERE resolved_at IS NULL' : ''} ORDER BY opened_at DESC, id`).all();
        return Response.json({ incidents: results });
      }
      const api = /^\/api\/tasks(?:\/([^/]+)(?:\/(rotate-token|snippet))?)?$/.exec(path);
      if (api) {
        await requireAdmin(request, env.ADMIN_TOKEN);
        return await management(request, env, api[1], api[2]);
      }
      const confirm = /^\/rerun\/([^/]+)$/.exec(path);
      if (confirm) return await rerun(request, env, confirm[1]);
      const hb = /^\/hb\/([^/]+)(\/fail)?$/.exec(path);
      if (hb && (request.method === 'POST' || (request.method === 'GET' && !hb[2]))) {
        return await heartbeat(request, env, hb[1], Boolean(hb[2]));
      }
      return jsonError(404, 'not_found', 'Not found');
    } catch (error) {
      if (error instanceof HttpError) return jsonError(error.status, error.code, error.message);
      console.error('Request failed', error instanceof Error ? error.message : 'Unknown error');
      return jsonError(500, 'internal_error', 'Internal server error');
    }
  },
  async scheduled(controller, env, _ctx): Promise<void> {
    await runScan(env, new Date(controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
