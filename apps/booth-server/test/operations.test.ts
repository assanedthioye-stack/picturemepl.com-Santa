import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, writeSynced } from '@pmp/db';
import { uuidv7 } from '../src/ids';
import { makeBooth } from './harness';

let t: Awaited<ReturnType<typeof makeBooth>>;
beforeAll(async () => { t = await makeBooth(); });
afterAll(async () => { await t.close(); });

async function staff(role: 'host' | 'photographer' | 'cashier' | 'supervisor') {
  const c = t.client();
  await c.login((await t.addUser(role)).id);
  return c;
}
const until = async (fn: () => boolean) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 25)); };

/** An online appointment as the cloud will deliver it (Phase 3 sync). */
function onlineBooking(status: 'confirmed' | 'pending_payment', code: string) {
  const c = writeSynced(t.booth.db, schema.customers, { id: uuidv7(), phone: '+2250707123456', country: 'CI', fullName: 'Famille Kouassi' });
  return writeSynced(t.booth.db, schema.bookings, {
    id: uuidv7(), code, publicToken: uuidv7(), pinHash: 'x', eventId: 'e', boothId: t.boothId, customerId: c.id, source: 'online', status, partySize: 3,
  });
}

describe('booth day: host → photographer → cashier', () => {
  let host: Awaited<ReturnType<typeof staff>>, ph: typeof host, cashier: typeof host;
  let familyBookingId = '';

  it('host registers walk-ins and checks in appointments ahead of them', async () => {
    host = await staff('host');
    const bad = await host.post('/api/queue/walk-in', { fullName: 'Famille Diop', phone: '77 123 45', country: 'SN', partySize: 4 });
    expect((await bad.json()).error).toBe('invalid_phone');

    const w1 = await (await host.post('/api/queue/walk-in', { fullName: 'Famille Diop', phone: '77 123 45 67', country: 'SN', partySize: 4 })).json();
    expect(w1.bookingCode).toMatch(/^9\d{5}$/); // walk-in range
    expect(w1.pin).toMatch(/^\d{6}$/);
    await host.post('/api/queue/walk-in', { fullName: 'Famille Houngbo', phone: '01 97 12 34 56', country: 'BJ' });

    onlineBooking('pending_payment', '111111');
    expect((await host.post('/api/queue/check-in', { code: '111111' })).status).toBe(409);
    onlineBooking('confirmed', '222222');
    // A QR may carry a URL; the 6-digit code is pulled out of it.
    expect((await host.post('/api/queue/check-in', { code: 'https://picturemeplease.app/b/tok?code=222222' })).status).toBe(201);
    expect((await (await host.post('/api/queue/check-in', { code: '222222' })).json()).alreadyCheckedIn).toBe(true);
    expect((await host.post('/api/queue/check-in', { code: '999999' })).status).toBe(404);

    const queue = await (await host.get('/api/queue')).json();
    // Appointment first, then walk-ins in arrival order.
    expect(queue.map((q: any) => [q.lane, q.name])).toEqual([
      ['booked', 'Famille Kouassi'], ['walk_in', 'Famille Diop'], ['walk_in', 'Famille Houngbo'],
    ]);
    const customer = t.booth.db.select().from(schema.customers).where(eq(schema.customers.fullName, 'Famille Diop')).get()!;
    expect([customer.phone, customer.country]).toEqual(['+221771234567', 'SN']);
  });

  it('send to photographer → shoot → finish sends the family to the cashier', async () => {
    const [first] = await (await host.get('/api/queue')).json();
    familyBookingId = first.bookingId;
    expect((await host.post(`/api/queue/${first.id}/send`)).status).toBe(201);
    expect((await host.post(`/api/queue/${first.id}/send`)).status).toBe(409); // already called

    ph = await staff('photographer');
    const [session] = await (await ph.get('/api/sessions')).json();
    expect(session).toMatchObject({ familyName: 'Famille Kouassi', bookingCode: '222222', status: 'dispatched', photoCount: 0 });
    await ph.post(`/api/sessions/${session.id}/arm`);
    const cam = [...t.booth.cameras.values()][0]!;
    for (let i = 0; i < 3; i++) await ph.post(`/api/cameras/${cam.cameraId}/shutter`);
    await cam.idle();
    expect((await (await ph.get('/api/sessions')).json())[0].photoCount).toBe(3);
    await ph.post(`/api/sessions/${session.id}/complete`);

    const q = await (await host.get('/api/queue')).json();
    expect(q.map((e: any) => e.name)).toEqual(['Famille Diop', 'Famille Houngbo']); // done entries leave the queue
  });

  it('roles stay in their lane', async () => {
    cashier = await staff('cashier');
    expect((await cashier.post('/api/queue/check-in', { code: '222222' })).status).toBe(403);
    expect((await host.get('/api/pos/families')).status).toBe(403);
  });

  it('cashier: Famille package, cash with drawer, prints + wallets + upload queued', async () => {
    const families = await (await cashier.get('/api/pos/families')).json();
    expect(families).toHaveLength(1);
    expect(families[0]).toMatchObject({ familyName: 'Famille Kouassi', photoCount: 3 });
    expect((await cashier.post(`/api/pos/families/${familyBookingId}/show`)).status).toBe(200);

    const pkgs = await (await cashier.get('/api/pos/packages')).json();
    // Senegal column of the October 2026 price list.
    expect(pkgs.map((p: any) => [p.code, p.priceXof])).toEqual([
      ['essentiel', 7_500], ['famille', 10_000], ['prestige', 18_000], ['numerique', 5_000],
      ['tirage_20x25', 3_500], ['tirage_13x18', 2_500], ['tirages_10x15', 1_500], ['portefeuille', 1_500],
    ]);
    const famille = pkgs.find((p: any) => p.code === 'famille');
    const photos = (await (await cashier.get(`/api/pos/families/${familyBookingId}/photos`)).json()).map((p: any) => p.id);
    const [a, b, c] = photos;
    // Famille: 1 × 20×25, 2 × 13×18, 2 × 10×15, 8 wallets (2 sheets), 1 digital file.
    const slots = [['8x10', a], ['5x7', a], ['5x7', b], ['4x6', b], ['4x6', b], ['wallet4', c], ['wallet4', c]].map(([size, photoId]) => ({ size, photoId }));

    const tooMany = await cashier.post('/api/pos/orders', { bookingId: familyBookingId, lines: [{ packageId: famille.id, qty: 1 }], digitalPhotoIds: [a, b], printSlots: slots });
    expect((await tooMany.json()).error).toBe('too_many_digitals');
    const noWallets = await cashier.post('/api/pos/orders', { bookingId: familyBookingId, lines: [{ packageId: famille.id, qty: 1 }], digitalPhotoIds: [a], printSlots: slots.slice(0, 5) });
    expect((await noWallets.json()).error).toBe('print_slots_mismatch_wallet4');

    const order = await (await cashier.post('/api/pos/orders', {
      bookingId: familyBookingId, lines: [{ packageId: famille.id, qty: 1 }], digitalPhotoIds: [a], printSlots: slots,
    })).json();
    expect(order).toMatchObject({ totalXof: 10_000, vatXof: 1525, status: 'open' }); // 10000 × 18/118

    expect((await (await cashier.post(`/api/pos/orders/${order.id}/pay`, { method: 'cash', tenderedXof: 15_000 })).json()).error).toBe('drawer_closed');
    expect((await cashier.post('/api/pos/drawer/open', { openingFloatXof: 5_000 })).status).toBe(201);
    expect((await (await cashier.post(`/api/pos/orders/${order.id}/pay`, { method: 'cash', tenderedXof: 9_000 })).json()).error).toBe('tendered_too_low');
    const paid = await (await cashier.post(`/api/pos/orders/${order.id}/pay`, { method: 'cash', tenderedXof: 15_000 })).json();
    expect(paid.changeXof).toBe(5_000);
    expect((await cashier.post(`/api/pos/orders/${order.id}/pay`, { method: 'cash', tenderedXof: 15_000 })).status).toBe(409);

    // One job per (size, photo): 20×25 on the PIXMA; 13×18 ×2, 10×15 (2 copies) and the wallet sheets (2 copies) on the DNP.
    await until(() => t.printed.length === 5);
    expect(t.printed.map((p) => [p.o.printer, p.o.copies]).sort()).toEqual([
      ['Canon PIXMA TS8320', 1], ['DNP DS620A', 1], ['DNP DS620A', 1], ['DNP DS620A', 2], ['DNP DS620A', 2],
    ]);
    const uploads = t.booth.db.select().from(schema.uploadJobs).all();
    expect(uploads).toHaveLength(3 * 3); // shoot complete: thumb + preview + original for every photo
    // The purchased original jumps the queue.
    expect(uploads.filter((u) => u.priority === 10).map((u) => [u.photoId, u.kind, u.status])).toEqual([[a, 'deliverable', 'queued']]);
    expect((await (await cashier.get('/api/pos/families')).json())).toHaveLength(0);
    // Paid: gone from the shoot list, and cannot be re-armed.
    const sessions = await (await ph.get('/api/sessions')).json();
    expect(sessions.some((s: any) => s.bookingId === familyBookingId)).toBe(false);
    const done = t.booth.db.select().from(schema.photoSessions).where(eq(schema.photoSessions.bookingId, familyBookingId)).get()!;
    expect((await (await ph.post(`/api/sessions/${done.id}/arm`)).json()).error).toBe('booking_completed');

    // The paid 4x6 lines cannot be reprinted as 8x10 through the manual endpoint.
    const line = t.booth.db.select().from(schema.orderItems).where(eq(schema.orderItems.printSize, '4x6')).get()!;
    expect((await cashier.post('/api/print-jobs', { orderItemId: line.id, photoId: line.photoId, size: '8x10', copies: 1 })).status).toBe(409);

    const closed = await (await cashier.post('/api/pos/drawer/close', { countedXof: 14_500 })).json();
    expect(closed).toEqual({ expectedXof: 15_000, countedXof: 14_500, varianceXof: -500 });
  });

  it('Mobile Money: country methods only, needs a reference, a reference works once', async () => {
    // Shoot a second family quickly.
    const [next] = await (await host.get('/api/queue')).json();
    const session = await (await host.post(`/api/queue/${next.id}/send`)).json();
    await ph.post(`/api/sessions/${session.id}/arm`);
    const cam = [...t.booth.cameras.values()][0]!;
    await ph.post(`/api/cameras/${cam.cameraId}/shutter`);
    await cam.idle();
    await ph.post(`/api/sessions/${session.id}/complete`);

    const pkgs = await (await cashier.get('/api/pos/packages')).json();
    const digital = pkgs.find((p: any) => p.code === 'numerique');
    const photos = (await (await cashier.get(`/api/pos/families/${next.bookingId}/photos`)).json()).map((p: any) => p.id);
    const order = await (await cashier.post('/api/pos/orders', { bookingId: next.bookingId, lines: [{ packageId: digital.id, qty: 1 }], digitalPhotoIds: photos.slice(0, 1), printSlots: [] })).json();
    expect(order.totalXof).toBe(5_000);
    expect((await cashier.post(`/api/pos/orders/${order.id}/pay`, { method: 'wave', reference: 'x' })).status).toBe(400);
    // Senegal takes Orange Money and Wave, not MTN MoMo (Benin).
    expect((await (await cashier.post(`/api/pos/orders/${order.id}/pay`, { method: 'mtn_momo', reference: 'MP123456' })).json()).error).toBe('method_not_offered');
    expect((await cashier.post(`/api/pos/orders/${order.id}/pay`, { method: 'wave', reference: 'T_ABC123' })).status).toBe(200);
    const p = t.booth.db.select().from(schema.payments).where(eq(schema.payments.providerTxId, 'T_ABC123')).get()!;
    expect([p.provider, p.status, p.drawerSessionId]).toEqual(['manual', 'succeeded', null]);

    // Same receipt shown again for another order → refused.
    const other = onlineBooking('confirmed', '333333');
    writeSynced(t.booth.db, schema.bookings, { id: other.id, status: 'shot_complete' });
    const s2 = writeSynced(t.booth.db, schema.photoSessions, { id: uuidv7(), bookingId: other.id, boothId: t.boothId, code: 'ZZZZ', status: 'shot_complete' });
    const photo = writeSynced(t.booth.db, schema.photos, { id: uuidv7(), sessionId: s2.id, bookingId: other.id, seq: 1, originalName: 'a.jpg', fileName: 'a.jpg', sha256: 'h', ingestStatus: 'ready' });
    const o2 = await (await cashier.post('/api/pos/orders', { bookingId: other.id, lines: [{ packageId: digital.id, qty: 1 }], digitalPhotoIds: [photo.id], printSlots: [] })).json();
    expect((await (await cashier.post(`/api/pos/orders/${o2.id}/pay`, { method: 'wave', reference: 'T_ABC123' })).json()).error).toBe('reference_already_used');
  });
});

describe('price list per country', () => {
  it('a Benin booth sells Benin prices and takes MTN MoMo / Celtiis Cash', async () => {
    const bj = await makeBooth(() => ({ PMP_COUNTRY: 'BJ' }));
    try {
      const c = bj.client();
      await c.login((await bj.addUser('cashier')).id);
      const me = await (await c.get('/api/auth/me')).json();
      expect(me.boothCountry).toBe('BJ');
      const pkgs = await (await c.get('/api/pos/packages')).json();
      expect(pkgs.slice(0, 4).map((p: any) => [p.code, p.priceXof])).toEqual([['essentiel', 6_500], ['famille', 8_500], ['prestige', 15_500], ['numerique', 4_500]]);
      expect(pkgs.every((p: any) => p.country === 'BJ')).toBe(true);
    } finally {
      await bj.close();
    }
  });

  it('retires old packages when the price list changes', async () => {
    const { seedPackages } = await import('../src/routes/pos');
    const { setSetting } = await import('@pmp/db');
    const db = t.booth.db;
    writeSynced(db, schema.packages, { id: uuidv7(), code: 'combo', country: 'SN', nameFr: 'Combo', nameEn: 'Combo', priceXof: 25_000, prints: {} });
    setSetting(db, 'packages.version', 'placeholder');
    seedPackages(db);
    const active = db.select().from(schema.packages).where(eq(schema.packages.active, true)).all();
    expect(active.some((p) => p.code === 'combo')).toBe(false);
    expect(active).toHaveLength(8 * 3); // 8 items × SN/CI/BJ
  });
});
