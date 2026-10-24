import type { Env } from './env';
import type { Incident, Task } from './models';
import { pingToken, sha256 } from './security';
import { escapeHtml } from './html';

async function deliver(env: Env, task: Task, subject: string, text: string, link?: string): Promise<void> {
  let url: string;
  let headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let body: Record<string, unknown>;
  if (task.alert_channel === 'telegram') {
    if (!env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
    url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    body = { chat_id: task.alert_target, text, disable_web_page_preview: true };
    if (link?.startsWith('https://')) body.reply_markup = { inline_keyboard: [[{ text: 'Confirm re-run', url: link }]] };
  } else {
    if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not configured');
    url = 'https://api.resend.com/emails';
    headers = { ...headers, Authorization: `Bearer ${env.RESEND_API_KEY}` };
    body = { from: env.ALERT_FROM_EMAIL, to: [task.alert_target], subject, text,
      html: `<p>${escapeHtml(text).replaceAll('\n', '<br>')}</p>${link ? `<p><a href="${escapeHtml(link)}">Confirm re-run</a></p>` : ''}` };
  }
  const send = () => fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  let response = await send();
  await response.body?.cancel();
  if (response.status === 400 && body.reply_markup) {
    delete body.reply_markup;
    try {
      response = await send();
      await response.body?.cancel();
      if (!response.ok) throw new Error(`Alert provider returned HTTP ${response.status}`);
    } catch (cause) {
      throw new Error(`Telegram button fallback failed: ${cause instanceof Error ? cause.message : 'Alert delivery failed'}`);
    }
  }
  if (!response.ok) throw new Error(`Alert provider returned HTTP ${response.status}`);
}

async function recordDelivery(env: Env, incident: Incident, send: () => Promise<void>, kind: 'opened' | 'recovery' | 'unknown' = 'opened'): Promise<void> {
  let error: string | null = null;
  try { await send(); } catch (cause) { error = (cause instanceof Error ? cause.message : 'Alert delivery failed').slice(0, 1000); }
  const sql = kind === 'unknown'
    ? 'UPDATE incidents SET rerun_unknown_alert_status = ?, rerun_unknown_alert_error = ? WHERE id = ?'
    : kind === 'recovery'
    ? 'UPDATE incidents SET recovery_notice_status = ?, recovery_notice_error = ? WHERE id = ?'
    : 'UPDATE incidents SET alert_status = ?, alert_error = ? WHERE id = ?';
  await env.DB.prepare(sql).bind(error === null ? 'sent' : 'failed', error, incident.id).run();
}

export async function notifyIncidentOpened(env: Env, task: Task, incident: Incident, rerunToken?: string): Promise<void> {
  await recordDelivery(env, incident, async () => {
    let link: string | undefined;
    if (task.rerun_webhook_url) {
      if (!rerunToken) {
        rerunToken = pingToken();
        await env.DB.prepare('UPDATE incidents SET rerun_token_hash = ? WHERE id = ?').bind(await sha256(rerunToken), incident.id).run();
      }
      link = `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/rerun/${incident.id}?t=${encodeURIComponent(rerunToken)}`;
    }
    const kind = incident.kind === 'failed' ? 'reported failure' : 'missed';
    const local = new Intl.DateTimeFormat('en-GB', { timeZone: task.timezone, dateStyle: 'full', timeStyle: 'long' }).format(new Date(incident.expected_at));
    const lines = [task.name, `Kind: ${kind}`, `Expected: ${incident.expected_at} (UTC)`, `Expected in ${task.timezone}: ${local}`, `Grace: ${task.grace_minutes} minute${task.grace_minutes === 1 ? '' : 's'}`, `Last heartbeat: ${task.last_heartbeat_at ?? 'never'} / ${task.last_status ?? 'none'}`];
    if (incident.kind === 'failed') {
      const heartbeat = await env.DB.prepare('SELECT message FROM heartbeats WHERE task_id = ? AND received_at = ? AND status = ? ORDER BY id LIMIT 1').bind(task.id, incident.expected_at, 'fail').first<{ message: string | null }>();
      if (heartbeat?.message) lines.push(`Failure message: ${heartbeat.message}`);
    }
    if (link) lines.push(`Confirm re-run: ${link}`);
    await deliver(env, task, `${task.name}: ${kind}`, lines.join('\n'), link);
  });
}
export async function notifyRecovered(env: Env, task: Task, incident: Incident): Promise<void> {
  await recordDelivery(env, incident, () => deliver(env, task, `${task.name}: recovered`, `${task.name}: recovered: ${incident.resolution === 'recovered' ? 'an ok heartbeat was received after a failure' : 'late heartbeat received'}`), 'recovery');
}

export async function notifyRerunUnknown(env: Env, task: Task, incident: Incident): Promise<void> {
  await recordDelivery(env, incident, () => deliver(env, task, `${task.name}: re-run result unknown`,
    `${task.name}: The previous re-run request may already have been delivered to the webhook but its result was never recorded. Check whether the task actually ran; no automatic retry.`), 'unknown');
}
