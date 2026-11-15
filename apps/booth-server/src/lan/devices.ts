import { createHash, randomBytes } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { desc, eq } from 'drizzle-orm';
import QRCode from 'qrcode';
import { z } from 'zod';
import { schema, type Db } from '@pmp/db';
import type { Deps } from '../app';
import { audit } from '../audit';
import { cookie, readCookies, requirePerm, staffOf } from '../auth/auth';
import { HttpError } from '../http';
import { uuidv7 } from '../ids';

export const DEVICE_COOKIE = 'pmp_device';
const PAIR_TTL_MS = 5 * 60_000;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** The booth PC itself (Electron windows). Decided by the socket, never by headers. */
export function isLoopback(req: Request): boolean {
  const a = req.socket.remoteAddress ?? '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

const OPEN_PATHS = new Set(['/setup', '/ca.crt']);

/**
 * LAN rules: plain HTTP only serves the certificate setup page; HTTPS needs a paired device
 * (then the usual staff PIN login). The booth PC on loopback is always trusted.
 */
export function lanGuard(db: Db, httpsPort: number) {
  const lastSeen = new Map<string, number>();
  return (req: Request, res: Response, next: NextFunction) => {
    if (isLoopback(req) || OPEN_PATHS.has(req.path)) return next();
    if (!req.secure) {
      if (req.method !== 'GET') return res.status(403).json({ error: 'https_required' });
      return res.redirect(`https://${req.hostname}:${httpsPort}${req.originalUrl}`);
    }
    if (req.path === '/pair') return next();
    const token = readCookies(req)[DEVICE_COOKIE];
    const device = token
      ? db.select().from(schema.devices).where(eq(schema.devices.tokenHash, sha256(token))).get()
      : undefined;
    if (!device || device.revokedAt) {
      return req.path.startsWith('/api/') || req.path.startsWith('/media/')
        ? res.status(403).json({ error: 'device_not_paired' })
        : res.status(403).type('html').send(notPairedPage);
    }
    const now = Date.now();
    if (now - (lastSeen.get(device.id) ?? 0) > 60_000) { // throttle writes
      lastSeen.set(device.id, now);
      db.update(schema.devices).set({ lastSeenAt: now }).where(eq(schema.devices.id, device.id)).run();
    }
    next();
  };
}

const PairBody = z.object({ name: z.string().trim().min(1).max(60) });

export function pairingRoutes(deps: Deps): Router {
  const { db, boothId, config } = deps; // deps.tls is read per request: it appears once the network is up
  const r = Router();
  const pending = new Map<string, { name: string; by: string; exp: number }>();

  // Pairing must be started on the booth PC itself: physical access is the trust anchor.
  r.post('/api/devices/pair', requirePerm('devices.manage'), async (req, res) => {
    if (!isLoopback(req)) throw new HttpError(403, 'pair_from_booth_pc_only');
    const { name } = PairBody.parse(req.body);
    const ip = deps.tls?.ips[0];
    if (!ip) throw new HttpError(409, 'no_lan_address');
    const token = randomBytes(24).toString('base64url');
    pending.set(token, { name, by: staffOf(req).id, exp: Date.now() + PAIR_TTL_MS });
    const setupUrl = `http://${ip}:${config.port}/setup`;
    const pairUrl = `https://${ip}:${config.httpsPort}/pair?t=${token}`;
    const svg = (text: string) => QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.json({ setupUrl, pairUrl, setupQr: await svg(setupUrl), pairQr: await svg(pairUrl), expiresAt: Date.now() + PAIR_TTL_MS });
  });

  r.get('/pair', (req, res) => {
    const token = String(req.query.t ?? '');
    const p = pending.get(token);
    pending.delete(token); // one use, even when expired
    if (!req.secure || !p || p.exp < Date.now()) return res.status(403).type('html').send(notPairedPage);
    const deviceToken = randomBytes(32).toString('base64url');
    const id = uuidv7();
    db.insert(schema.devices).values({ id, name: p.name, tokenHash: sha256(deviceToken), pairedBy: p.by, pairedAt: Date.now() }).run();
    audit(db, boothId, { action: 'device.pair', actorId: p.by, entity: 'device', entityId: id, data: { name: p.name } });
    // Lax: the first load comes from the camera app's QR intent, a cross-site navigation.
    res.setHeader('Set-Cookie', cookie(DEVICE_COOKIE, deviceToken, 400 * 86400, { secure: true, sameSite: 'Lax' }));
    res.redirect('/');
  });

  r.get('/api/devices', requirePerm('devices.manage'), (_req, res) => {
    res.json(db.select({ id: schema.devices.id, name: schema.devices.name, pairedAt: schema.devices.pairedAt,
      lastSeenAt: schema.devices.lastSeenAt, revokedAt: schema.devices.revokedAt })
      .from(schema.devices).orderBy(desc(schema.devices.pairedAt)).all());
  });

  r.post('/api/devices/:id/revoke', requirePerm('devices.manage'), (req, res) => {
    const user = staffOf(req);
    const n = db.update(schema.devices).set({ revokedAt: Date.now() }).where(eq(schema.devices.id, String(req.params.id))).run().changes;
    if (!n) throw new HttpError(404, 'device_not_found');
    audit(db, boothId, { action: 'device.revoke', actorId: user.id, actorRole: user.role, entity: 'device', entityId: String(req.params.id) });
    res.json({ ok: true });
  });

  r.get('/ca.crt', (_req, res) => {
    if (!deps.tls) throw new HttpError(404, 'lan_not_ready');
    res.type('application/x-x509-ca-cert').attachment('PictureMePlease-Booth-CA.crt').send(deps.tls.caCert);
  });
  r.get('/setup', (_req, res) => res.type('html').send(setupPage));

  return r;
}

const page = (body: string) => `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Picture Me Please</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#0f172a}
h1{color:#be123c}a.btn{display:inline-block;background:#be123c;color:#fff;padding:.8rem 1.2rem;border-radius:.6rem;text-decoration:none;font-weight:600}
li{margin:.4rem 0}.en{color:#475569}</style></head><body>${body}</body></html>`;

const setupPage = page(`<h1>Installer le certificat de la cabine</h1>
<p class="en">Install the booth certificate (once per tablet)</p>
<p><a class="btn" href="/ca.crt">Télécharger le certificat / Download certificate</a></p>
<h2>Android</h2><ol><li>Paramètres → Sécurité → Chiffrement et identifiants → Installer un certificat → <b>Certificat CA</b>.</li>
<li>Choisissez le fichier téléchargé.</li></ol>
<p class="en">Settings → Security → Encryption &amp; credentials → Install a certificate → CA certificate.</p>
<h2>iPad / iPhone</h2><ol><li>Réglages → Général → VPN et gestion de l'appareil → installez le profil.</li>
<li>Réglages → Général → Informations → Réglages des certificats → activez la confiance totale.</li></ol>
<p class="en">Settings → General → VPN &amp; Device Management → install; then General → About → Certificate Trust Settings → enable full trust.</p>
<h2>Ensuite / Then</h2><p>Scannez le 2<sup>e</sup> QR code affiché sur le PC de la cabine. <span class="en">Scan the second QR code shown on the booth PC.</span></p>`);

const notPairedPage = page(`<h1>Appareil non autorisé</h1>
<p>Demandez à un superviseur d'appairer cet appareil depuis le PC de la cabine.</p>
<p class="en">This device is not paired. Ask a supervisor to pair it from the booth PC.</p>`);
