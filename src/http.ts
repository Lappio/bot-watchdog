export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}
export async function jsonBody(request: Request, optional = false): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (optional && !text.trim()) return {};
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new HttpError(400, 'invalid_json', 'Expected a JSON object'); }
}
