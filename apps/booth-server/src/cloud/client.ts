/** Error from the cloud API: `code` is its short error ("order_paid", "provider_error"…), status 0 = unreachable. */
export class CloudError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

export interface CloudClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

export function cloudClient(o: { url: string; token: string; timeoutMs?: number }): CloudClient {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${o.url}${path}`, {
        method,
        headers: { Authorization: `Bearer ${o.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(o.timeoutMs ?? 20_000), // mall networks drop; never hang the cashier
      });
    } catch {
      throw new CloudError(0, 'cloud_unreachable');
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new CloudError(res.status, data.error ?? `http_${res.status}`);
    return data as T;
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}
