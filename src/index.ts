import type { Env } from './env';
import { runScan } from './scanner';
import { management } from './api';
import { stats, integerParam } from './stats';
import { publicIncident, type Incident } from './models';
import { rerun, adminRerun } from './rerun';
import { heartbeat } from './heartbeat';
import { HttpError, jsonError } from './http';
import { historyHtml, scheduleHtml, scheduleTasks, taskRuns } from './history';
import { escapeHtml, htmlResponse } from './html';
import { requireAdmin } from './security';

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && (path === '/' || path === '/dashboard')) return Response.redirect(new URL('/dashboard/', request.url).href, 302);
      const incidentRerun = /^\/api\/incidents\/([^/]+)\/rerun$/.exec(path);
      if (path === '/api/stats' || incidentRerun) {
        await requireAdmin(request, env.ADMIN_TOKEN);
        if (request.method !== (incidentRerun ? 'POST' : 'GET')) throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
        return incidentRerun ? await adminRerun(env, incidentRerun[1]) : await stats(request, env);
      }
      if (request.method === 'GET' && path === '/healthz') return Response.json({ ok: true });
      const history = /^\/admin\/tasks\/([^/]+)\/history$/.exec(path);
      if (path.startsWith('/admin/')) {
        await requireAdmin(request, env.ADMIN_TOKEN);
        if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
        if (path === '/admin/schedule') return await scheduleHtml(env);
        if (history) return await historyHtml(env, history[1]);
        throw new HttpError(404, 'not_found', 'Not found');
      }
      const runs = /^\/api\/tasks\/([^/]+)\/runs$/.exec(path);
      if (path === '/api/schedule' || runs) {
        await requireAdmin(request, env.ADMIN_TOKEN);
        if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
        if (runs) return await taskRuns(request, env, runs[1]);
        return Response.json({ tasks: await scheduleTasks(env, new Date()) });
      }
      if (path === '/api/incidents') {
        await requireAdmin(request, env.ADMIN_TOKEN);
        if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
        const status = new URL(request.url).searchParams.get('status') ?? 'open';
        if (status !== 'open' && status !== 'all') throw new HttpError(400, 'validation_error', 'status must be open or all');
        const params = new URL(request.url).searchParams;
        const limit = integerParam(params.get('limit'), 200, 500, 'limit');
        const taskId = params.get('task_id');
        const conditions = [...(status === 'open' ? ['i.resolved_at IS NULL'] : []), ...(taskId !== null ? ['i.task_id = ?'] : [])];
        const { results } = await env.DB.prepare(`SELECT i.*, t.name AS task_name, t.bot AS task_bot FROM incidents i JOIN tasks t ON t.id = i.task_id ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''} ORDER BY i.opened_at DESC, i.id LIMIT ?`)
          .bind(...(taskId !== null ? [taskId] : []), limit).all<Incident & { task_name: string; task_bot: string | null }>();
        return Response.json({ incidents: results.map(publicIncident) });
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
        return await heartbeat(request, env, hb[1], Boolean(hb[2]), ctx);
      }
      return jsonError(404, 'not_found', 'Not found');
    } catch (error) {
      if (new URL(request.url).pathname.startsWith('/admin/')) {
        return htmlResponse(`<h1>${escapeHtml(error instanceof HttpError ? error.message : 'Internal server error')}</h1>`, error instanceof HttpError ? error.status : 500);
      }
      if (error instanceof HttpError) return jsonError(error.status, error.code, error.message);
      console.error('Request failed', error instanceof Error ? error.message : 'Unknown error');
      return jsonError(500, 'internal_error', 'Internal server error');
    }
  },
  async scheduled(controller, env, _ctx): Promise<void> {
    await runScan(env, new Date(controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
