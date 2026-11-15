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
    expect(w1.bookingCode).toMatch(/^\d{6}$/);
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

  it('cashier: combo order, cash with drawer, prints + uploads queued', async () => {
    const families = await (await cashier.get('/api/pos/families')).json();
    expect(families).toHaveLength(1);
    expect(families[0]).toMatchObject({ familyName: 'Famille Kouassi', photoCount: 3 });
    expect((await cashier.post(`/api/pos/families/${familyBookingId}/show`)).status).toBe(200);

    const pkgs = await (await cashier.get('/api/pos/packages')).json();
    expect(pkgs.map((p: any) => p.code)).toEqual(['digital', 'dnp_4x6', 'pixma_8x10', 'combo']);
    const combo = pkgs.find((p: any) => p.code === 'combo');
    const photos = (await (await cashier.get(`/api/pos/families/${familyBookingId}/photos`)).json()).map((p: any) => p.id);

    const wrong = await cashier.post('/api/pos/orders', { bookingId: familyBookingId, lines: [{ packageId: combo.id, qty: 1 }], digitalPhotoIds: photos, printSlots: [] });
    expect((await wrong.json()).error).toMatch(/print_slots_mismatch/);

    const orderRes = await cashier.post('/api/pos/orders', {
      bookingId: familyBookingId, lines: [{ packageId: combo.id, qty: 1 }], digitalPhotoIds: photos,
      printSlots: [{ size: '4x6', photoId: photos[0] }, { size: '4x6', photoId: photos[0] }, { size: '4x6', photoId: photos[1] }, { size: '8x10', photoId: photos[2] }],
    });
    const order = await orderRes.json();
    expect(order).toMatchObject({ totalXof: 25_000, vatXof: 3814, status: 'open' }); // 25000 × 18/118

    expect((await (await cashier.post(`/api/pos/orders/${order.id}/pay`, { method: 'cash', tenderedXof: 30_000 })).json()).error).toBe('drawer_closed');
    expect((await cashier.post('/api/pos/drawer/open', { openingFloatXof: 5_000 })).status).toBe(201);
    expect((await (await cashier.post(`/api/pos/orders/${order.id}/pay`, { method: 'cash', tenderedXof: 20_000 })).json()).error).toBe('tendered_too_low');
    const paid = await (await cashier.post(`/api/pos/orders/${order.id}/pay`, { method: 'cash', tenderedXof: 30_000 })).json();
    expect(paid.changeXof).toBe(5_000);
    expect((await cashier.post(`/api/pos/orders/${order.id}/pay`, { method: 'cash', tenderedXof: 30_000 })).status).toBe(409);

    // Prints: photo 0 ×2 (one job, 2 copies) + photo 1 on the DNP, photo 2 on the PIXMA.
    await until(() => t.printed.length === 3);
    expect(t.printed.map((p) => [p.o.printer, p.o.copies]).sort()).toEqual([
      ['Canon PIXMA TS8320', 1], ['DNP DS620A', 1], ['DNP DS620A', 2],
    ]);
    const uploads = t.booth.db.select().from(schema.uploadJobs).all();
    expect(uploads.map((u) => [u.kind, u.priority, u.status])).toEqual(Array(3).fill(['deliverable', 10, 'queued']));
    expect((await (await cashier.get('/api/pos/families')).json())).toHaveLength(0);

    // The paid 4x6 lines cannot be reprinted as 8x10 through the manual endpoint.
    const line = t.booth.db.select().from(schema.orderItems).where(eq(schema.orderItems.printSize, '4x6')).get()!;
    expect((await cashier.post('/api/print-jobs', { orderItemId: line.id, photoId: line.photoId, size: '8x10', copies: 1 })).status).toBe(409);

    const closed = await (await cashier.post('/api/pos/drawer/close', { countedXof: 29_500 })).json();
    expect(closed).toEqual({ expectedXof: 30_000, countedXof: 29_500, varianceXof: -500 });
  });

  it('Mobile Money: needs a reference, and a reference works only once', async () => {
    // Shoot a second family quickly.
    const [next] = await (await host.get('/api/queue')).json();
    const session = await (await host.post(`/api/queue/${next.id}/send`)).json();
    await ph.post(`/api/sessions/${session.id}/arm`);
    const cam = [...t.booth.cameras.values()][0]!;
    await ph.post(`/api/cameras/${cam.cameraId}/shutter`);
    await cam.idle();
    await ph.post(`/api/sessions/${session.id}/complete`);

    const pkgs = await (await cashier.get('/api/pos/packages')).json();
    const digital = pkgs.find((p: any) => p.code === 'digital');
    const photos = (await (await cashier.get(`/api/pos/families/${next.bookingId}/photos`)).json()).map((p: any) => p.id);
    const order = await (await cashier.post('/api/pos/orders', { bookingId: next.bookingId, lines: [{ packageId: digital.id, qty: 1 }], digitalPhotoIds: photos, printSlots: [] })).json();
    expect((await cashier.post(`/api/pos/orders/${order.id}/pay`, { method: 'wave', reference: 'x' })).status).toBe(400);
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
