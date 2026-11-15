import { signToken, verifyToken } from './util';

/** Private photo bucket. Clients never get the service key: only short-lived signed URLs. */
export interface Storage {
  /** URL the booth PUTs the file to (valid a few minutes). */
  signUpload(key: string, contentType: string): Promise<{ url: string; headers: Record<string, string> }>;
  signDownloads(keys: string[], ttlSec: number): Promise<Record<string, string>>;
}

/** Supabase Storage REST API. */
export function supabaseStorage(o: { url: string; serviceKey: string; bucket: string }): Storage {
  const api = `${o.url.replace(/\/$/, '')}/storage/v1`;
  const auth = { Authorization: `Bearer ${o.serviceKey}`, apikey: o.serviceKey };
  return {
    async signUpload(key, contentType) {
      const r = await fetch(`${api}/object/upload/sign/${o.bucket}/${key}`, { method: 'POST', headers: { ...auth, 'x-upsert': 'true' } });
      if (!r.ok) throw new Error(`storage_sign_upload_${r.status}`);
      const { url } = (await r.json()) as { url: string };
      return { url: `${api}${url}`, headers: { 'content-type': contentType, 'x-upsert': 'true' } };
    },
    async signDownloads(keys, ttlSec) {
      if (keys.length === 0) return {};
      const r = await fetch(`${api}/object/sign/${o.bucket}`, {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ expiresIn: ttlSec, paths: keys }),
      });
      if (!r.ok) throw new Error(`storage_sign_download_${r.status}`);
      const rows = (await r.json()) as Array<{ path: string; signedURL: string | null }>;
      return Object.fromEntries(rows.filter((x) => x.signedURL).map((x) => [x.path, `${api}${x.signedURL}`]));
    },
  };
}

/** Local folder storage for development and tests; URLs point at /dev-storage on this API. */
export function devStorage(o: { baseUrl: string; secret: string; files: Map<string, { body: Uint8Array; type: string }> }): Storage & {
  handle(req: Request): Promise<Response>;
} {
  const sign = (key: string) => signToken(o.secret, key, 600);
  return {
    async signUpload(key, contentType) {
      return { url: `${o.baseUrl}/dev-storage/${key}?t=${await sign(key)}`, headers: { 'content-type': contentType } };
    },
    async signDownloads(keys) {
      return Object.fromEntries(await Promise.all(keys.map(async (k) => [k, `${o.baseUrl}/dev-storage/${k}?t=${await sign(k)}`])));
    },
    async handle(req) {
      const u = new URL(req.url);
      const key = decodeURIComponent(u.pathname.replace(/^\/dev-storage\//, ''));
      if (!(await verifyToken(o.secret, u.searchParams.get('t') ?? '', key))) return new Response('forbidden', { status: 403 });
      if (req.method === 'PUT') {
        o.files.set(key, { body: new Uint8Array(await req.arrayBuffer()), type: req.headers.get('content-type') ?? 'application/octet-stream' });
        return new Response(null, { status: 200 });
      }
      const f = o.files.get(key);
      return f ? new Response(f.body as unknown as BodyInit, { headers: { 'content-type': f.type } }) : new Response('not found', { status: 404 });
    },
  };
}
