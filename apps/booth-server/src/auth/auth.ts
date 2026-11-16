import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { and, count, eq, gt, lt } from 'drizzle-orm';
import type { NextFunction, Request, Response } from 'express';
import { schema, type Db } from '@pmp/db';
import { can, type Permission, type StaffRole } from '@pmp/shared';
import { audit } from '../audit';

export const STAFF_COOKIE = 'pmp_staff';
export const KIOSK_COOKIE = 'pmp_kiosk';
const SESSION_MS = 12 * 60 * 60 * 1000;
const LOCK_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;

export interface StaffUser { id: string; fullName: string; role: StaffRole; locale: 'fr' | 'en' }
export type PrincipalCtx = { kind: 'staff'; user: StaffUser } | { kind: 'kiosk' };

declare global {
  namespace Express {
    interface Request { principal?: PrincipalCtx }
  }
}

export const hashSecret = (secret: string) => hash(secret); // argon2id defaults
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export type LoginResult =
  | { ok: true; token: string; user: StaffUser }
  | { ok: false; reason: 'invalid' | 'locked' };

export async function login(db: Db, boothId: string, userId: string, secret: string): Promise<LoginResult> {
  const user = db.select().from(schema.users)
    .where(and(eq(schema.users.id, userId), eq(schema.users.active, true))).get();
  if (!user?.pinHash) return { ok: false, reason: 'invalid' };

  // Lockout is derived from the audit log: no separate counter to tamper with.
  const fails = db.select({ n: count() }).from(schema.auditLogs).where(and(
    eq(schema.auditLogs.action, 'auth.fail'),
    eq(schema.auditLogs.entityId, userId),
    gt(schema.auditLogs.at, Date.now() - LOCK_WINDOW_MS),
  )).get()!.n;
  if (fails >= MAX_FAILS) {
    audit(db, boothId, { action: 'auth.locked', entity: 'user', entityId: userId });
    return { ok: false, reason: 'locked' };
  }

  if (!(await verify(user.pinHash, secret))) {
    audit(db, boothId, { action: 'auth.fail', entity: 'user', entityId: userId });
    return { ok: false, reason: fails + 1 >= MAX_FAILS ? 'locked' : 'invalid' };
  }

  db.delete(schema.staffSessions).where(lt(schema.staffSessions.expiresAt, Date.now())).run(); // housekeeping
  const token = randomBytes(32).toString('base64url');
  db.insert(schema.staffSessions).values({
    tokenHash: sha256(token), userId, deviceId: 'booth-pc', expiresAt: Date.now() + SESSION_MS,
  }).run();
  audit(db, boothId, { action: 'auth.login', actorId: userId, actorRole: user.role, entity: 'user', entityId: userId });
  return { ok: true, token, user: { id: user.id, fullName: user.fullName, role: user.role, locale: user.locale } };
}

export function logout(db: Db, token: string): void {
  db.delete(schema.staffSessions).where(eq(schema.staffSessions.tokenHash, sha256(token))).run();
}

function staffFromToken(db: Db, token: string): StaffUser | null {
  const row = db.select({ user: schema.users, expiresAt: schema.staffSessions.expiresAt })
    .from(schema.staffSessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.staffSessions.userId))
    .where(eq(schema.staffSessions.tokenHash, sha256(token))).get();
  if (!row || row.expiresAt < Date.now() || !row.user.active) return null;
  const u = row.user;
  return { id: u.id, fullName: u.fullName, role: u.role, locale: u.locale };
}

export function readCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function cookie(name: string, value: string, maxAgeSec: number, o: { secure?: boolean; sameSite?: 'Strict' | 'Lax' } = {}): string {
  return `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=${o.sameSite ?? 'Strict'}; Path=/; Max-Age=${maxAgeSec}${o.secure ? '; Secure' : ''}`;
}
export const SESSION_SEC = SESSION_MS / 1000;

/** Attaches req.principal from the staff or kiosk cookie. Never rejects; requirePerm does. */
export function authenticate(db: Db, kioskToken: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const c = readCookies(req);
    const staff = c[STAFF_COOKIE] ? staffFromToken(db, c[STAFF_COOKIE]) : null;
    if (staff) req.principal = { kind: 'staff', user: staff };
    else if (c[KIOSK_COOKIE] && safeEqual(c[KIOSK_COOKIE], kioskToken)) req.principal = { kind: 'kiosk' };
    next();
  };
}

export function requirePerm(...perms: Permission[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const p = req.principal;
    if (!p) return res.status(401).json({ error: 'unauthenticated' });
    const who = p.kind === 'kiosk' ? 'kiosk' : p.user.role;
    if (!perms.some((perm) => can(who, perm))) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}

/** The signed-in staff user; only call after requirePerm with a staff permission. */
export function staffOf(req: Request): StaffUser {
  if (req.principal?.kind !== 'staff') throw new Error('staff principal required');
  return req.principal.user;
}
