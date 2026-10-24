import type { Env } from './env';
import { invalid } from './validation';

export function integerParam(value: string | null, fallback: number, max: number, name: string): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || !Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > max) invalid(`${name} must be an integer from 1 to ${max}`);
  return Number(value);
}

export async function stats(request: Request, env: Env, now = new Date()): Promise<Response> {
  const days = integerParam(new URL(request.url).searchParams.get('days'), 14, 90, 'days');
  const generated_at = now.toISOString();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (days - 1) * 86400000).toISOString();
  const cutoff = new Date(now.getTime() - 86400000).toISOString();
  const [tasks, incidents, beats, dailyBeats, dailyIncidents] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS tasks, COALESCE(SUM(paused = 0),0) AS active, COALESCE(SUM(paused != 0),0) AS paused,
      COALESCE(SUM(paused = 0 AND (last_status IS NULL OR last_status != 'fail') AND NOT EXISTS (SELECT 1 FROM incidents i WHERE i.task_id = tasks.id AND i.resolved_at IS NULL)),0) AS healthy,
      COALESCE(SUM(EXISTS (SELECT 1 FROM incidents i WHERE i.task_id = tasks.id AND i.resolved_at IS NULL)),0) AS with_open_incidents FROM tasks`).first(),
    env.DB.prepare('SELECT COUNT(*) AS open_incidents FROM incidents WHERE resolved_at IS NULL').first(),
    env.DB.prepare("SELECT COUNT(*) AS heartbeats_24h, COALESCE(SUM(status = 'fail'),0) AS failed_heartbeats_24h FROM heartbeats WHERE received_at >= ? AND received_at <= ?").bind(cutoff, generated_at).first(),
    env.DB.prepare("SELECT substr(received_at,1,10) AS date, SUM(status = 'ok') AS ok, SUM(status = 'fail') AS fail FROM heartbeats WHERE received_at >= ? AND received_at <= ? GROUP BY substr(received_at,1,10)").bind(start, generated_at).all<{ date: string; ok: number; fail: number }>(),
    env.DB.prepare('SELECT substr(opened_at,1,10) AS date, COUNT(*) AS incidents_opened FROM incidents WHERE opened_at >= ? AND opened_at <= ? GROUP BY substr(opened_at,1,10)').bind(start, generated_at).all<{ date: string; incidents_opened: number }>(),
  ]);
  const heartbeats = new Map(dailyBeats.results.map(row => [row.date, row]));
  const opened = new Map(dailyIncidents.results.map(row => [row.date, row.incidents_opened]));
  const series = Array.from({ length: days }, (_, i) => {
    const date = new Date(Date.parse(start) + i * 86400000).toISOString().slice(0, 10);
    return { date, ok: heartbeats.get(date)?.ok ?? 0, fail: heartbeats.get(date)?.fail ?? 0, incidents_opened: opened.get(date) ?? 0 };
  });
  return Response.json({ generated_at, totals: { ...tasks, ...incidents, ...beats }, series });
}
