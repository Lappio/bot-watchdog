import type { Env } from './env';
import { publicIncident } from './models';
import type { Incident, Task } from './models';
import { escapeHtml as esc, htmlResponse } from './html';
import { sha256 } from './security';
import { jsonBody } from './http';

function page(task: Task, incident: Incident, token: string, message = '', status = 200): Response {
  const resolvedMessage = incident.resolution === 'late_heartbeat'
    ? 'The task already ran on its own (a heartbeat arrived) — no re-run is needed.'
    : incident.resolution === 'rerun_ok' ? 'The task was already re-run — no re-run is needed.'
    : incident.resolution === 'recovered' ? 'The task recovered — no re-run is needed.'
    : 'This incident was already resolved — no re-run is needed.';
  const action = incident.resolved_at ? `<p>${esc(resolvedMessage)}</p>`
    : incident.rerun_status === 'unknown' ? '<p>The previous re-run result is unknown. Check whether the task actually ran; no automatic retry.</p>'
    : !task.rerun_webhook_url ? '<p>No rerun webhook is configured for this task.</p>'
    : incident.rerun_requested_at ? '<p>Re-run already requested. This is single-shot; failed requests are not retried automatically.</p>'
    : `<form method="post" action="/rerun/${esc(encodeURIComponent(incident.id))}"><input type="hidden" name="t" value="${esc(token)}"><button type="submit">Confirm re-run</button></form>`;
  return htmlResponse(`<h1>${esc(task.name)}</h1><p>Expected: ${esc(incident.expected_at)}</p><p>Current rerun status: ${esc(incident.rerun_status)}</p>${message ? `<p>${esc(message)}</p>` : ''}${action}`, status);
}
export async function rerun(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') return htmlResponse('<p>Method not allowed</p>', 405);
  const incident = await env.DB.prepare('SELECT * FROM incidents WHERE id = ?').bind(id).first<Incident>();
  if (!incident) return htmlResponse('<p>Incident not found</p>', 404);
  const form = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/x-www-form-urlencoded';
  const wantsHtml = request.method === 'GET' || form || Boolean(request.headers.get('accept')?.includes('text/html'));
  let token: unknown;
  if (request.method === 'GET') token = new URL(request.url).searchParams.get('t');
  else if (form) token = (await request.formData()).get('t');
  else {
    try { token = (await jsonBody(request)).t; }
    catch { return wantsHtml ? htmlResponse('<p>Invalid request body</p>', 400) : Response.json({ ok: false, status: 'invalid_body' }, { status: 400 }); }
  }
  const hash = await sha256(typeof token === 'string' ? token : '');
  if (typeof token !== 'string' || !token || !incident.rerun_token_hash || !crypto.subtle.timingSafeEqual(new TextEncoder().encode(hash), new TextEncoder().encode(incident.rerun_token_hash))) {
    return htmlResponse('<p>Invalid or missing rerun token</p>', 403);
  }
  const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(incident.task_id).first<Task>();
  if (!task) return htmlResponse('<p>Task not found</p>', 404);
  if (request.method === 'GET') return page(task, incident, token);
  const respond = (current: Incident, ok: boolean, status: number) => wantsHtml
    ? page(task, current, token as string, ok ? 'Re-run succeeded.' : '', status)
    : Response.json({ ok, status: current.rerun_status, ...(!ok && current.resolved_at ? { resolved: true, resolution: current.resolution } : {}) }, { status });
  const result = await claimAndRerun(env, task, incident, hash);
  return respond(result.incident, result.ok, result.code);
}

export async function adminRerun(env: Env, id: string): Promise<Response> {
  const incident = await env.DB.prepare('SELECT * FROM incidents WHERE id = ?').bind(id).first<Incident>();
  if (!incident) return Response.json({ ok: false, status: 'not_found', incident: null }, { status: 404 });
  const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(incident.task_id).first<Task>();
  if (!task) return Response.json({ ok: false, status: 'not_found', incident: null }, { status: 404 });
  const result = await claimAndRerun(env, task, incident);
  return Response.json({ ok: result.ok, status: result.incident.rerun_status, incident: publicIncident(result.incident) }, { status: result.code });
}

async function claimAndRerun(env: Env, task: Task, incident: Incident, tokenHash?: string): Promise<{ ok: boolean; code: number; incident: Incident }> {
  const id = incident.id;
  if (!task.rerun_webhook_url || incident.resolved_at || incident.rerun_status === 'unknown') return { incident, ok: false, code: 409 };
  // Only the winner of this database claim may make the external request.
  const claimed = await env.DB.prepare(`UPDATE incidents SET rerun_requested_at = ?, rerun_status = 'requested' WHERE id = ? ${tokenHash !== undefined ? 'AND rerun_token_hash = ?' : ''} AND rerun_requested_at IS NULL AND resolved_at IS NULL AND rerun_status = 'none'`)
    .bind(new Date().toISOString(), id, ...(tokenHash !== undefined ? [tokenHash] : [])).run();
  if (claimed.meta.changes !== 1) {
    const current = await env.DB.prepare('SELECT * FROM incidents WHERE id = ?').bind(id).first<Incident>();
    return { incident: current ?? incident, ok: false, code: 409 };
  }
  let code: number | null = null;
  let error: string | null = null;
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Idempotency-Key': id };
    if (task.rerun_webhook_secret) headers.Authorization = `Bearer ${task.rerun_webhook_secret}`;
    const response = await fetch(task.rerun_webhook_url, { method: 'POST', headers,
      body: JSON.stringify({ event: 'bot-watchdog.rerun', task_id: task.id, task_name: task.name, incident_id: id, expected_at: incident.expected_at }),
      signal: AbortSignal.timeout(10000), redirect: 'manual',
    });
    code = response.status;
    await response.body?.cancel();
    if (!response.ok) error = `Webhook returned HTTP ${code}`;
  } catch (cause) { error = (cause instanceof Error ? cause.message : 'Webhook request failed').slice(0, 1000); }
  const status = error === null ? 'succeeded' : 'failed';
  await env.DB.prepare(`UPDATE incidents SET rerun_status = ?, rerun_response_code = ?, rerun_error = ?,
    resolved_at = CASE WHEN ? = 'succeeded' THEN ? ELSE resolved_at END,
    resolution = CASE WHEN ? = 'succeeded' THEN 'rerun_ok' ELSE resolution END WHERE id = ?`)
    .bind(status, code, error, status, new Date().toISOString(), status, id).run();
  const current = await env.DB.prepare('SELECT * FROM incidents WHERE id = ?').bind(id).first<Incident>();
  return { incident: current!, ok: error === null, code: error === null ? 200 : 502 };
}
