import { validateExpression, validateTimezone } from './cron';
import { HttpError } from './http';
import type { Task } from './models';
export function invalid(message: string): never { throw new HttpError(400, 'validation_error', message); }
export function httpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}
export function taskInput(body: Record<string, unknown>, existing?: Task) {
  const defaults = { timezone: 'UTC', grace_minutes: 15, rerun_webhook_url: null, rerun_webhook_secret: null, paused: false };
  const data = { ...defaults, ...existing, ...body };
  if (typeof data.name !== 'string' || data.name.trim().length < 1 || data.name.length > 100) invalid('name must be 1..100 characters');
  if (typeof data.schedule !== 'string' || !validateExpression(data.schedule)) invalid('schedule must be a valid five-field cron');
  if (typeof data.timezone !== 'string' || !validateTimezone(data.timezone)) invalid('timezone must be a valid IANA timezone');
  if (!Number.isInteger(data.grace_minutes) || (data.grace_minutes as number) < 1 || (data.grace_minutes as number) > 1440) invalid('grace_minutes must be an integer from 1 to 1440');
  if (!['email', 'telegram'].includes(data.alert_channel as string)) invalid('alert_channel must be telegram or email');
  if (typeof data.alert_target !== 'string' || !(data.alert_channel === 'email' ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.alert_target) : /^(?:-?\d+|@[a-zA-Z][a-zA-Z0-9_]{4,31})$/.test(data.alert_target))) invalid('Invalid alert_target');
  if (data.rerun_webhook_url !== null) {
    if (!httpUrl(data.rerun_webhook_url)) invalid('Invalid rerun_webhook_url');
    const url = new URL(data.rerun_webhook_url as string);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) invalid('rerun_webhook_url must use HTTPS (except localhost/127.0.0.1)');
  }
  if (data.rerun_webhook_secret !== null && (typeof data.rerun_webhook_secret !== 'string' || data.rerun_webhook_secret.length > 512)) invalid('rerun_webhook_secret must be at most 512 characters');
  if ('paused' in body && typeof body.paused !== 'boolean') invalid('paused must be a boolean');
  // Explicit allowlist: unknown input fields never reach SQL or override credentials.
  return {
    name: data.name as string, schedule: data.schedule as string, timezone: data.timezone as string,
    grace_minutes: data.grace_minutes as number, alert_channel: data.alert_channel as Task['alert_channel'], alert_target: data.alert_target as string,
    rerun_webhook_url: data.rerun_webhook_url as string | null, rerun_webhook_secret: data.rerun_webhook_secret as string | null,
    paused: existing ? Number(data.paused) : 0,
  };
}
