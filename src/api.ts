import type { Env } from './env';
import { HttpError, jsonBody } from './http';
import { type Task, type Incident, publicTask, publicIncident } from './models';
import { pingToken, randomId, sha256 } from './security';
import { generateSnippet, heartbeatUrl } from './snippet';
import { taskInput } from './validation';

export async function management(request: Request, env: Env, id?: string, action?: string): Promise<Response> {
  const method = request.method;
  if (!id && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM tasks ORDER BY created_at DESC, id').all<Task>();
    return Response.json({ tasks: results.map(publicTask) });
  }
  if (!id && method === 'POST') {
    const data = taskInput(await jsonBody(request));
    const token = pingToken();
    const now = new Date().toISOString();
    const task: Task = { ...data, id: randomId('tsk_'), ping_token_hash: await sha256(token), schedule_anchor_at: now, created_at: now, updated_at: now, last_heartbeat_at: null, last_status: null };
    const keys = Object.keys(task);
    await env.DB.prepare(`INSERT INTO tasks (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).bind(...Object.values(task)).run();
    return Response.json({ task: publicTask(task), ...credentials(task, env, token) }, { status: 201 });
  }
  if (!id) throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
  const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first<Task>();
  if (!task) throw new HttpError(404, 'not_found', 'Task not found');
  if (action === 'snippet' && method === 'GET') {
    return new Response(generateSnippet(task, env.PUBLIC_BASE_URL), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  if (action === 'rotate-token' && method === 'POST') {
    const token = pingToken();
    await env.DB.prepare('UPDATE tasks SET ping_token_hash = ?, updated_at = ? WHERE id = ?').bind(await sha256(token), new Date().toISOString(), id).run();
    return Response.json(credentials(task, env, token));
  }
  if (action) throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
  if (method === 'GET') {
    const [heartbeats, incidents] = await Promise.all([
      env.DB.prepare('SELECT * FROM heartbeats WHERE task_id = ? ORDER BY received_at DESC, rowid DESC LIMIT 20').bind(id).all(),
      env.DB.prepare('SELECT * FROM incidents WHERE task_id = ? AND resolved_at IS NULL ORDER BY opened_at DESC').bind(id).all<Incident>(),
    ]);
    return Response.json({ task: publicTask(task), recent_heartbeats: heartbeats.results, open_incidents: incidents.results.map(publicIncident) });
  }
  if (method === 'PATCH') {
    const data = { ...taskInput(await jsonBody(request), task), updated_at: new Date().toISOString() };
    const resetAnchor = (task.paused === 1 && data.paused === 0) || task.schedule !== data.schedule || task.timezone !== data.timezone;
    const anchored = { ...data, schedule_anchor_at: resetAnchor ? data.updated_at : task.schedule_anchor_at };
    await env.DB.prepare(`UPDATE tasks SET ${Object.keys(anchored).map(k => `${k} = ?`).join(',')} WHERE id = ?`).bind(...Object.values(anchored), id).run();
    return Response.json({ task: publicTask({ ...task, ...anchored }) });
  }
  if (method === 'DELETE') {
    await env.DB.prepare('DELETE FROM tasks WHERE id = ?').bind(id).run();
    return Response.json({ ok: true });
  }
  throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
}
function credentials(task: Task, env: Env, token: string) {
  return { ping_token: token, heartbeat_url: heartbeatUrl(env.PUBLIC_BASE_URL, token), snippet: generateSnippet(task, env.PUBLIC_BASE_URL, token) };
}
