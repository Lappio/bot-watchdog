import type { Env } from './env';
import type { Incident, Task } from './models';
// Unit (c) implements delivery. Awaited hooks keep heartbeat behavior deterministic.
export async function notifyIncidentOpened(_env: Env, _task: Task, _incident: Incident): Promise<void> {}
export async function notifyRecovered(_env: Env, _task: Task, _incident: Incident): Promise<void> {}
