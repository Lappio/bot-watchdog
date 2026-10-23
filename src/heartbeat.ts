import type { Env } from './env';
import { notifyIncidentOpened, notifyRecovered } from './alerts';
import { HttpError, jsonBody } from './http';
import type { Incident, Task } from './models';
import { randomId, sha256 } from './security';
import { httpUrl, invalid } from './validation';

export async function heartbeat(request: Request, env: Env, token: string, fail: boolean): Promise<Response> {
  const task = await env.DB.prepare('SELECT * FROM tasks WHERE ping_token_hash = ?').bind(await sha256(token)).first<Task>();
  if (!task) throw new HttpError(404, 'not_found', 'Unknown heartbeat token');
  const body = request.method === 'POST' ? await jsonBody(request, true) : {};
  const status = fail ? 'fail' : body.status ?? 'ok';
  if (status !== 'ok' && status !== 'fail') invalid('status must be ok or fail');
  if (body.run_id !== undefined && (typeof body.run_id !== 'string' || body.run_id.length > 200)) invalid('run_id must be at most 200 characters');
  if (body.output_url !== undefined && (!httpUrl(body.output_url) || body.output_url.length > 2000)) invalid('output_url must be an HTTP(S) URL of at most 2000 characters');
  if (body.message !== undefined && typeof body.message !== 'string') invalid('message must be a string');
  const now = new Date().toISOString();
  // RETURNING selects precisely the incidents won by this heartbeat, even under concurrent requests.
  const statements = [
    env.DB.prepare('INSERT INTO heartbeats (id, task_id, received_at, status, run_id, output_url, message) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(randomId('hb_'), task.id, now, status, body.run_id ?? null, body.output_url ?? null, typeof body.message === 'string' ? body.message.slice(0, 2000) : null),
    env.DB.prepare('UPDATE tasks SET last_heartbeat_at = ?, last_status = ? WHERE id = ?').bind(now, status, task.id),
    env.DB.prepare("UPDATE incidents SET resolved_at = ?, resolution = 'late_heartbeat' WHERE task_id = ? AND kind = 'missed' AND resolved_at IS NULL AND expected_at <= ? RETURNING *").bind(now, task.id, now),
  ];
  if (status === 'fail') statements.push(env.DB.prepare("INSERT OR IGNORE INTO incidents (id, task_id, kind, expected_at, opened_at) VALUES (?, ?, 'failed', ?, ?) RETURNING *").bind(randomId('inc_'), task.id, now, now));
  const results = await env.DB.batch<Incident>(statements);
  task.last_heartbeat_at = now;
  task.last_status = status;
  for (const incident of results[2].results) await notifyRecovered(env, task, incident);
  for (const incident of results[3]?.results ?? []) await notifyIncidentOpened(env, task, incident);
  return Response.json({ ok: true, task_id: task.id, received_at: now });
}
