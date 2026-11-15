import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, setSetting } from '@pmp/db';
import { verifyAuditChain } from '../src/audit';
import { ingestFile, previewPath } from '../src/photos/ingest';
import { resolvePrinter } from '../src/print/router';
import { KIOSK_TOKEN, makeBooth } from './harness';

let t: Awaited<ReturnType<typeof makeBooth>>;
beforeAll(async () => { t = await makeBooth(); });
afterAll(async () => { await t.close(); });

async function waitFor<T>(fn: () => T | undefined | null | false, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('PIN login + RBAC', () => {
  it('rejects a wrong PIN, then locks the account after 5 failures', async () => {
    const u = await t.addUser('cashier', '4321');
    const c = t.client();
    for (let i = 0; i < 4; i++) expect((await c.login(u.id, '0000')).status).toBe(401);
    expect((await c.login(u.id, '0000')).status).toBe(423);
    // Even the right PIN is refused while locked.
    expect((await c.login(u.id, '4321')).status).toBe(423);
  });

  it('logs in, exposes /me, and enforces permissions', async () => {
    const cashier = await t.addUser('cashier');
    const anon = t.client();
    expect((await anon.get('/api/auth/me')).status).toBe(401);
    expect((await anon.get('/api/sessions')).status).toBe(401);

    const c = t.client();
    const res = await c.login(cashier.id);
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Strict/);
    expect((await (await c.get('/api/auth/me')).json()).role).toBe('cashier');
    expect((await c.get('/api/sessions')).status).toBe(403); // cashier cannot see the shoot queue
    expect((await c.get('/api/print-jobs')).status).toBe(200);
  });

  it('refuses non-JSON writes (CSRF hardening)', async () => {
    const res = await fetch(`${t.base}/api/auth/logout`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
    expect(res.status).toBe(415);
  });

  it('keeps an intact, tamper-evident audit chain', () => {
    expect(verifyAuditChain(t.booth.db)).toBeNull();
    const row = t.booth.db.select().from(schema.auditLogs).limit(1).get()!;
    t.booth.db.update(schema.auditLogs).set({ action: 'auth.login' }).where(eq(schema.auditLogs.id, row.id)).run();
    expect(verifyAuditChain(t.booth.db)).toBe(row.id);
    t.booth.db.update(schema.auditLogs).set({ action: row.action }).where(eq(schema.auditLogs.id, row.id)).run();
  });
});

describe('tethered shoot → session folder → watermarked preview → kiosk', () => {
  let sessionId = '';
  let bookingId = '';
  const photographer = t_client();
  const kiosk = t_client();
  function t_client() { return { c: null as ReturnType<typeof t.client> | null }; }

  it('host dispatches, photographer arms', async () => {
    const host = t.client();
    await host.login((await t.addUser('host')).id);
    const booking = t.seedBooking();
    bookingId = booking.id;
    const res = await host.post('/api/sessions', { bookingCode: booking.code.toLowerCase() });
    expect(res.status).toBe(201);
    sessionId = (await res.json()).id;
    expect((await host.post(`/api/sessions/${sessionId}/arm`)).status).toBe(403); // host cannot shoot

    photographer.c = t.client();
    await photographer.c.login((await t.addUser('photographer')).id);
    expect((await photographer.c.post(`/api/sessions/${sessionId}/arm`)).status).toBe(200);
  });

  it('remote shutter downloads into Sessions\\{id}\\ and builds a preview', async () => {
    const cams = await (await photographer.c!.get('/api/cameras')).json();
    expect(cams[0]).toMatchObject({ connected: true, driver: 'mock', canRemoteShutter: true, batteryPercent: 87, armedSessionId: sessionId });
    for (let i = 0; i < 2; i++) expect((await photographer.c!.post(`/api/cameras/${cams[0].id}/shutter`)).status).toBe(200);
    await [...t.booth.cameras.values()][0]!.idle();

    const photos = t.booth.db.select().from(schema.photos).where(eq(schema.photos.sessionId, sessionId)).orderBy(schema.photos.seq).all();
    expect(photos.map((p) => [p.seq, p.fileName, p.ingestStatus])).toEqual([[1, 'IMG_0001.JPG', 'ready'], [2, 'IMG_0002.JPG', 'ready']]);
    expect(existsSync(path.join(t.root, 'Sessions', sessionId, 'IMG_0001.JPG'))).toBe(true);
    const meta = await sharp(previewPath(path.join(t.root, 'Sessions'), photos[0]!)).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(1600); // 3000px original, full-res kept on disk
    expect(photos[0]!.width).toBe(3000);
  });

  it('pairs a RAW file with its JPEG whichever arrives first', async () => {
    const dir = path.join(t.root, 'Sessions', sessionId);
    writeFileSync(path.join(dir, 'IMG_0100.CR2'), 'raw-bytes');
    await ingestFile(ingestCtx(), path.join(dir, 'IMG_0100.CR2'), 'IMG_0100.CR2', sessionId);
    await sharp({ create: { width: 800, height: 1200, channels: 3, background: '#888' } }).jpeg().toFile(path.join(dir, 'IMG_0100.JPG'));
    const p = await ingestFile(ingestCtx(), path.join(dir, 'IMG_0100.JPG'), 'IMG_0100.JPG', sessionId);
    expect(p?.rawFileName).toBe('IMG_0100.CR2');
  });

  it('never shoots without an armed session', async () => {
    const cams = await (await photographer.c!.get('/api/cameras')).json();
    expect((await photographer.c!.post(`/api/sessions/${sessionId}/complete`)).status).toBe(200);
    expect((await photographer.c!.post(`/api/cameras/${cams[0].id}/shutter`)).status).toBe(409);
  });

  it('kiosk: token login, sees only this family, toggles favourites', async () => {
    kiosk.c = t.client();
    expect((await kiosk.c.get('/kiosk/auth?token=wrong')).status).toBe(403);
    expect((await kiosk.c.get(`/kiosk/auth?token=${KIOSK_TOKEN}`)).status).toBe(302);
    const state = await (await kiosk.c.get('/api/kiosk/state')).json();
    expect(state.session.id).toBe(sessionId);
    expect(state.photos).toHaveLength(3);

    const id = state.photos[0].id;
    expect((await (await kiosk.c.post(`/api/kiosk/photos/${id}/favorite`, { favorite: true })).json()).favorite).toBe(true);
    expect((await kiosk.c.get(state.photos[0].previewUrl)).headers.get('content-type')).toMatch(/image\/jpeg/);
    expect((await kiosk.c.get('/api/sessions')).status).toBe(403); // kiosk is not staff
    expect((await kiosk.c.post(`/api/sessions/${sessionId}/arm`)).status).toBe(403);

    // Hidden by the photographer → gone from the kiosk.
    await photographer.c!.post(`/api/photos/${id}/hidden`, { hidden: true });
    expect((await kiosk.c.get(state.photos[0].previewUrl)).status).toBe(404);
    expect((await (await kiosk.c.get('/api/kiosk/state')).json()).photos).toHaveLength(2);
  });

  it('print: refuses unpaid orders and over-printing; routes sizes to the right printer', async () => {
    const cashier = t.client();
    await cashier.login((await t.addUser('cashier')).id);
    const photo = t.booth.db.select().from(schema.photos).where(eq(schema.photos.seq, 2)).get()!;

    const unpaid = t.seedOrder(bookingId, 'open');
    expect((await cashier.post('/api/print-jobs', { orderItemId: unpaid.id, photoId: photo.id, size: '4x6', copies: 1 })).status).toBe(402);

    const paid = t.seedOrder(bookingId, 'paid', 2);
    expect((await cashier.post('/api/print-jobs', { orderItemId: paid.id, photoId: photo.id, size: '4x6', copies: 1 })).status).toBe(201);
    expect((await cashier.post('/api/print-jobs', { orderItemId: paid.id, photoId: photo.id, size: '8x10', copies: 1 })).status).toBe(201);
    expect((await cashier.post('/api/print-jobs', { orderItemId: paid.id, photoId: photo.id, size: '5x7', copies: 1 })).status).toBe(409);

    await waitFor(() => t.printed.length === 2);
    const byPrinter = Object.fromEntries(t.printed.map((p) => [p.o.printer, p]));
    expect(Object.keys(byPrinter).sort()).toEqual(['Canon PIXMA TS8320', 'DNP DS620A']);

    // Mock shots are 3000×2000 landscape → 6×4 in page on the DNP, 10×8 in on the PIXMA.
    const dnpPage = (await PDFDocument.load(byPrinter['DNP DS620A']!.pdf)).getPage(0).getSize();
    expect([dnpPage.width / 72, dnpPage.height / 72]).toEqual([6, 4]);
    expect(byPrinter['DNP DS620A']!.o.orientation).toBe('landscape');
    const pixmaPage = (await PDFDocument.load(byPrinter['Canon PIXMA TS8320']!.pdf)).getPage(0).getSize();
    expect([pixmaPage.width / 72, pixmaPage.height / 72]).toEqual([10, 8]);

    const jobs = t.booth.db.select().from(schema.printJobs).all();
    await waitFor(() => t.booth.db.select().from(schema.printJobs).all().every((j) => j.status === 'done'));
    expect(jobs).toHaveLength(2);
    expect(existsSync(path.join(t.root, 'PrintSpool', `${jobs[0]!.id}.pdf`))).toBe(false);
  });

  function ingestCtx() {
    return { db: t.booth.db, hub: t.booth.hub, sessionsDir: path.join(t.root, 'Sessions'), watermark: 'TEST' };
  }
});

describe('printer resolution', () => {
  const installed = ['DNP DS620A', 'DNP DS620A 5x7', 'Canon PIXMA TS8320'];
  it('prefers the shortest match, honours per-size overrides', () => {
    expect(resolvePrinter(t.booth.db, '4x6', installed).printer).toBe('DNP DS620A');
    expect(resolvePrinter(t.booth.db, 'custom', installed).printer).toBe('Canon PIXMA TS8320');
    setSetting(t.booth.db, 'print.printer.5x7', 'DNP DS620A 5x7');
    setSetting(t.booth.db, 'print.paper.5x7', '(5x7)');
    expect(resolvePrinter(t.booth.db, '5x7', installed)).toEqual({ printer: 'DNP DS620A 5x7', paperSize: '(5x7)' });
    expect(resolvePrinter(t.booth.db, 'wallet4', installed)).toEqual({ printer: 'DNP DS620A 5x7', paperSize: '(5x7)' }); // same media
    expect(() => resolvePrinter(t.booth.db, '4x6', ['Microsoft Print to PDF'])).toThrow('printer_not_found:DS620');
  });
});
