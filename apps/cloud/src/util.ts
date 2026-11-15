const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 16): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function randomDigits(n: number): string {
  const r = crypto.getRandomValues(new Uint32Array(n));
  return [...r].map((x) => String(x % 10)).join('');
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data))));
}

/** Compact signed token "subject.expiry.signature" (gallery sessions, dev storage URLs). */
export async function signToken(secret: string, subject: string, ttlSec: number): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  return `${subject}.${exp}.${await hmac(secret, `${subject}.${exp}`)}`;
}

export async function verifyToken(secret: string, token: string, subject: string): Promise<boolean> {
  // Parse from the right: subjects may contain dots (storage keys like ".../photo.webp").
  const j = token.lastIndexOf('.'), i = token.lastIndexOf('.', j - 1);
  const sub = token.slice(0, i), exp = token.slice(i + 1, j), sig = token.slice(j + 1);
  if (i < 0 || sub !== subject || !exp || !sig || Number(exp) < Date.now() / 1000) return false;
  const want = await hmac(secret, `${sub}.${exp}`);
  // constant-time compare
  if (want.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

/** UUIDv7-style time-ordered id (same shape as the booth's ids). */
export function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let ms = Date.now();
  for (let i = 5; i >= 0; i--) { b[i] = ms % 256; ms = Math.floor(ms / 256); }
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
export const camel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
