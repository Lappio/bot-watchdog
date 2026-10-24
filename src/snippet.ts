import type { Task } from './models';
export function heartbeatUrl(base: string, token: string): string { return `${base.replace(/\/+$/, '')}/hb/${token}`; }
export function generateSnippet(task: Pick<Task, 'name' | 'schedule' | 'timezone' | 'grace_minutes'>, base: string, token = '<YOUR_PING_TOKEN>'): string {
  const url = heartbeatUrl(base, token);
  const body = '{"status":"ok"}';
  const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
  return `Task: ${task.name}\nSchedule: ${task.schedule} (${task.timezone})\nGrace: ${task.grace_minutes} minute${task.grace_minutes === 1 ? '' : 's'}\n\nAt the very end of every run of this task (after you've delivered the result), send an HTTP POST to\n${url}\nwith JSON body ${body}. Optional run_id, if used, must be unique per run (for example, include the date/time); optional output_url is an HTTP(S) link to what you delivered; optional message is a short explanation. Replace any placeholders in the prose with your actual values.\nIf the task failed or you could not deliver, send the same request with "status":"fail" and a short "message", or POST to ${url}/fail.\nDo this even if earlier steps failed.\nEquivalent curl: curl -fsS -m 10 -X POST ${quote(url)} -H 'Content-Type: application/json' -d ${quote(body)}\nFailure curl: curl -fsS -m 10 -X POST ${quote(url)} -H 'Content-Type: application/json' -d ${quote('{"status":"fail","message":"short reason"}')}\n`;
}
