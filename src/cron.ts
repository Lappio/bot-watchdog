import { Cron } from 'croner';

export function validateTimezone(timezone: string): boolean {
  try {
    if (!timezone || /^[+-]/.test(timezone)) return false;
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    return true;
  } catch { return false; }
}

function job(expression: string, timezone: string): Cron {
  if (!validateTimezone(timezone)) throw new Error('Invalid IANA timezone');
  // Restrict Croner's extensions to standard numeric five-field cron syntax.
  if (expression.trim().split(/\s+/).length !== 5 || !/^[\d\s*,/\-]+$/.test(expression)) {
    throw new Error('Expected a standard five-field cron expression');
  }
  return new Cron(expression, { timezone, paused: true, legacyMode: true });
}

export function validateExpression(expression: string): boolean {
  try { job(expression, 'UTC'); return true; } catch { return false; }
}

/** Inclusive boundaries; null means the expression has no occurrence in that direction. */
export function previousOccurrence(expression: string, timezone: string, instant: Date): Date | null {
  if (!Number.isFinite(instant.getTime())) throw new Error('Invalid instant');
  const cron = job(expression, timezone);
  const minute = new Date(Math.floor(instant.getTime() / 60000) * 60000);
  // Croner strips milliseconds and normally excludes the reference second.
  return cron.previousRuns(1, new Date(minute.getTime() + 1000))[0] ?? null;
}

export function nextOccurrence(expression: string, timezone: string, instant: Date): Date | null {
  if (!Number.isFinite(instant.getTime())) throw new Error('Invalid instant');
  const cron = job(expression, timezone);
  if (instant.getTime() % 60000 === 0 && previousOccurrence(expression, timezone, instant)?.getTime() === instant.getTime()) return new Date(instant);
  return cron.nextRun(instant);
}
