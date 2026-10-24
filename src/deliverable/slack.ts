import type { CheckResult } from './types';
// Interface stub; connector authentication and lookup are follow-up work.
export async function checkDeliverable(): Promise<CheckResult> {
  return { ok: false, detail: 'not_implemented' };
}
