import type { Env } from '../env';
import type { CheckResult, DeliverableConfig } from './types';

export async function checkDeliverable(env: Env, config: DeliverableConfig): Promise<CheckResult> {
  if (!env.GITHUB_TOKEN) return { ok: false, detail: 'GITHUB_TOKEN is not configured' };
  const base = `https://api.github.com/repos/${encodeURIComponent(config.owner ?? '')}/${encodeURIComponent(config.repo ?? '')}`;
  const segment = (value: string) => encodeURIComponent(value);
  let url: string;
  switch (config.type) {
    case 'commit': url = `${base}/commits/${segment(config.sha ?? config.ref ?? 'HEAD')}`; break;
    case 'pr': case 'issue':
      if (!config.number) return { ok: false, detail: 'no number' };
      url = `${base}/${config.type === 'pr' ? 'pulls' : 'issues'}/${config.number}`; break;
    case 'file':
      if (!config.path) return { ok: false, detail: 'no path' };
      url = `${base}/contents/${config.path.split('/').map(segment).join('/')}${config.ref ? `?ref=${segment(config.ref)}` : ''}`; break;
    case 'url':
      if (!config.url) return { ok: false, detail: 'no url' };
      url = config.url; break;
    default: return { ok: false, detail: 'invalid github type' };
  }
  // Never forward the PAT to a redirect destination.
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000), headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'bot-watchdog',
    } });
    await response.body?.cancel();
    return { ok: response.ok, detail: `GitHub HTTP ${response.status}` };
  } catch (error) { return { ok: false, detail: error instanceof Error ? error.message : 'GitHub check failed' }; }
}
