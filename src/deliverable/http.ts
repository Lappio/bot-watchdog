import type { Heartbeat } from '../models';
import type { CheckResult, DeliverableConfig } from './types';

export async function checkDeliverable(config: DeliverableConfig, heartbeat: Pick<Heartbeat, 'output_url'>): Promise<CheckResult> {
  const url = config.url ?? heartbeat.output_url;
  if (!url) return { ok: false, detail: 'no url' };
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    try {
      if (config.expect_status !== undefined ? response.status !== config.expect_status : !response.ok) return { ok: false, detail: `HTTP ${response.status}` };
      if (config.expect_contains !== undefined) {
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (reader && size < 65536) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = value.subarray(0, 65536 - size);
            chunks.push(chunk); size += chunk.length;
          }
        } finally { await reader?.cancel(); }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        if (!new TextDecoder().decode(bytes).includes(config.expect_contains)) return { ok: false, detail: 'expected content missing' };
      }
      return { ok: true, detail: `HTTP ${response.status}` };
    } finally { if (!response.body?.locked) await response.body?.cancel(); }
  } catch (error) { return { ok: false, detail: error instanceof Error ? error.message : 'HTTP check failed' }; }
}
