import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@pmp/db';
import { cookie, KIOSK_COOKIE, login, logout, readCookies, safeEqual, SESSION_SEC, STAFF_COOKIE } from '../auth/auth';
import type { Deps } from '../app';

const LoginBody = z.object({ userId: z.string().min(1), secret: z.string().min(4).max(128) });

export function authRoutes({ db, boothId, config }: Deps): Router {
  const r = Router();

  // Tiles for the login screen. Server listens on loopback only in Phase 1.
  r.get('/api/auth/staff', (_req, res) => {
    res.json(db.select({ id: schema.users.id, fullName: schema.users.fullName, role: schema.users.role })
      .from(schema.users).where(eq(schema.users.active, true)).orderBy(schema.users.fullName).all());
  });

  r.post('/api/auth/login', async (req, res) => {
    const body = LoginBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid' });
    const result = await login(db, boothId, body.data.userId, body.data.secret);
    if (!result.ok) return res.status(result.reason === 'locked' ? 423 : 401).json({ error: result.reason });
    res.setHeader('Set-Cookie', cookie(STAFF_COOKIE, result.token, SESSION_SEC, { secure: req.secure }));
    res.json(result.user);
  });

  r.post('/api/auth/logout', (req, res) => {
    const token = readCookies(req)[STAFF_COOKIE];
    if (token) logout(db, token);
    res.setHeader('Set-Cookie', cookie(STAFF_COOKIE, '', 0));
    res.json({ ok: true });
  });

  r.get('/api/auth/me', (req, res) => {
    const p = req.principal;
    if (!p) return res.status(401).json({ error: 'unauthenticated' });
    res.json(p.kind === 'staff' ? p.user : { role: 'kiosk' });
  });

  // Electron main opens the kiosk window here once with the per-boot token.
  r.get('/kiosk/auth', (req, res) => {
    const token = String(req.query.token ?? '');
    if (!safeEqual(token, config.kioskToken)) return res.status(403).send('forbidden');
    res.setHeader('Set-Cookie', cookie(KIOSK_COOKIE, token, 7 * 24 * 3600));
    res.redirect('/kiosk');
  });

  return r;
}
