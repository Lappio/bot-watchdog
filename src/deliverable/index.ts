import type { Env } from '../env';
import type { Heartbeat, Task } from '../models';
import type { CheckResult, DeliverableConfig } from './types';
import { checkDeliverable as http } from './http';
import { checkDeliverable as github } from './github';
export async function runDeliverableCheck(env: Env, task: Task, heartbeat: Heartbeat): Promise<CheckResult> {
  try {
    const config: DeliverableConfig = task.deliverable_config ? JSON.parse(task.deliverable_config) : {};
    switch (task.deliverable_check) {
      case 'http': return await http(config, heartbeat);
      case 'github': return await github(env, config);
      default: return { ok: true, detail: 'disabled' };
    }
  } catch (error) { return { ok: false, detail: error instanceof Error ? error.message : 'Deliverable check failed' }; }
}
