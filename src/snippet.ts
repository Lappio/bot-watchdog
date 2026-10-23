import type { Task } from './models';
export function heartbeatUrl(base: string, token: string): string { return `${base.replace(/\/+$/, '')}/hb/${token}`; }
export function generateSnippet(task: Pick<Task, 'name' | 'schedule' | 'timezone' | 'grace_minutes'>, base: string, token = '<YOUR_PING_TOKEN>'): string {
  const url = heartbeatUrl(base, token);
  const body = '{"status":"ok","run_id":"<any unique id for this run>","output_url":"<link to what you delivered, if any>"}';
  const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
  return `Task: ${task.name}\nSchedule: ${task.schedule} (${task.timezone})\nGrace: ${task.grace_minutes} minute${task.grace_minutes === 1 ? '' : 's'}\n\nAt the very end of every run of this task (after you've delivered the result), send an HTTP POST to\n${url}\nwith JSON body ${body}. Omit output_url if there is no link.\nIf the task failed or you could not deliver, send the same request with "status":"fail" and a short "message", or POST to ${url}/fail.\nDo this even if earlier steps failed.\nEquivalent curl: curl -fsS -m 10 -X POST ${quote(url)} -H 'Content-Type: application/json' -d ${quote(body)}\n`;
}
