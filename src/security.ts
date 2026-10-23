import { HttpError } from './http';
export function randomId(prefix: string): string { return prefix + crypto.randomUUID().replaceAll('-', ''); }
export function pingToken(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
export async function sha256(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    b => b.toString(16).padStart(2, '0')).join('');
}
export async function requireAdmin(request: Request, token?: string): Promise<void> {
  if (!token) throw new HttpError(503, 'admin_not_configured', 'ADMIN_TOKEN is not configured');
  const match = /^Bearer (.+)$/.exec(request.headers.get('Authorization') ?? '');
  // Fixed-length digests keep comparison independent of credential length/content.
  const [actual, expected] = await Promise.all([sha256(match?.[1] ?? ''), sha256(token)]);
  const equal = crypto.subtle.timingSafeEqual(new TextEncoder().encode(actual), new TextEncoder().encode(expected));
  if (!match || !equal) throw new HttpError(401, 'unauthorized', 'Invalid or missing admin bearer token');
}
