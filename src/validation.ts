import { nextOccurrence, validateExpression, validateTimezone } from './cron';
import { HttpError } from './http';
import type { Task } from './models';
export function invalid(message: string): never { throw new HttpError(400, 'validation_error', message); }
export function httpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}
export function taskInput(body: Record<string, unknown>, existing?: Task) {
  const defaults = { bot: null, timezone: 'UTC', grace_minutes: 15, rerun_webhook_url: null, rerun_webhook_secret: null, paused: false, deliverable_check: 'none', deliverable_config: null, deliverable_delay_minutes: 5 };
  const data = { ...defaults, ...existing, ...body };
  if (typeof data.name !== 'string' || data.name.trim().length < 1 || data.name.length > 100) invalid('name must be 1..100 characters');
  if (data.bot !== null && (typeof data.bot !== 'string' || data.bot.trim().length > 100)) invalid('bot must be at most 100 characters');
  if (typeof data.schedule !== 'string' || !validateExpression(data.schedule)) invalid('schedule must be a valid five-field cron');
  if (typeof data.timezone !== 'string' || !validateTimezone(data.timezone)) invalid('timezone must be a valid IANA timezone');
  const now = new Date();
  const next = nextOccurrence(data.schedule, data.timezone, now);
  if (!next || next.getTime() > now.getTime() + 5 * 366 * 86400000) invalid('schedule never fires');
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
  if (!['none', 'http', 'github'].includes(data.deliverable_check as string)) invalid('Invalid deliverable_check');
  if (!Number.isInteger(data.deliverable_delay_minutes) || Number(data.deliverable_delay_minutes) < 0 || Number(data.deliverable_delay_minutes) > 1440) invalid('deliverable_delay_minutes must be an integer from 0 to 1440');
  let config: Record<string, unknown> | null = null;
  if (data.deliverable_config !== null) {
    let value: unknown = data.deliverable_config;
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { invalid('deliverable_config must be valid JSON'); }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('deliverable_config must be an object');
    config = value as Record<string, unknown>;
  }
  if (config?.url !== undefined && !httpUrl(config.url)) invalid('Invalid deliverable url');
  if (data.deliverable_check === 'http' && config) {
    if (config.expect_status !== undefined && (typeof config.expect_status !== 'number' || !Number.isFinite(config.expect_status))) invalid('expect_status must be a number');
    if (config.expect_contains !== undefined && (typeof config.expect_contains !== 'string' || config.expect_contains.length > 500)) invalid('expect_contains must be at most 500 characters');
  }
  if (data.deliverable_check === 'github') {
    if (!config || !['commit', 'pr', 'issue', 'file', 'url'].includes(config.type as string)) invalid('Invalid github type');
    if (config.type === 'url') { if (!httpUrl(config.url)) invalid('github url is required'); }
    else if (typeof config.owner !== 'string' || !config.owner || typeof config.repo !== 'string' || !config.repo) invalid('github owner and repo are required');
    for (const key of ['ref', 'path', 'sha']) if (config[key] !== undefined && typeof config[key] !== 'string') invalid(`github ${key} must be a string`);
    if (config.number !== undefined && (!Number.isInteger(config.number) || Number(config.number) < 1)) invalid('github number must be a positive integer');
  }
  // Explicit allowlist: unknown input fields never reach SQL or override credentials.
  return {
    name: data.name as string, bot: typeof data.bot === 'string' ? data.bot.trim() || null : null, schedule: data.schedule as string, timezone: data.timezone as string,
    grace_minutes: data.grace_minutes as number, alert_channel: data.alert_channel as Task['alert_channel'], alert_target: data.alert_target as string,
    rerun_webhook_url: data.rerun_webhook_url as string | null, rerun_webhook_secret: data.rerun_webhook_secret as string | null,
    deliverable_check: data.deliverable_check as Task['deliverable_check'], deliverable_config: config ? JSON.stringify(config) : null,
    deliverable_delay_minutes: data.deliverable_delay_minutes as number,
    paused: existing ? Number(data.paused) : 0,
  };
}
