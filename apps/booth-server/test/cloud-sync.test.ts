import { createServer } from 'node:net';
import { serve } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@pmp/db';
import { makeCloud } from '../../cloud/test/harness';
import { makeBooth } from './harness';

// Booth ↔ cloud for real: the cloud API on a local port backed by Postgres, the booth syncing with it.
let cloud: Awaited<ReturnType<typeof makeCloud>>;
let booth: Awaited<ReturnType<typeof makeBooth>>;
let server: ReturnType<typeof serve>;

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});

beforeAll(async () => {
  const port = await freePort();
  cloud = await makeCloud({ base: `http://127.0.0.1:${port}` });
  server = serve({ fetch: cloud.app.fetch, port, hostname: '127.0.0.1' });
  booth = await makeBooth(() => ({
    PMP_CLOUD_URL: `http://127.0.0.1:${port}`, PMP_CLOUD_TOKEN: cloud.sn.token, PMP_BOOTH_ID: cloud.sn.boothId, PMP_WEB_URL: 'https://web.test',
  }), { manualSync: true });
});
afterAll(async () => { await booth.close(); server.close(); await cloud.close(); });

const tick = () => booth.booth.sync!.tick().then(() => expect(booth.booth.sync!.lastError).toBeNull());
async function staff(role: 'host' | 'photographer' | 'cashier') {
  const c = booth.client();
  await c.login((await booth.addUser(role)).id);
  return c;
}

describe('online booking → booth → gallery', () => {
  let online: { token: string; code: string; pin: string };
  let host: Awaited<ReturnType<typeof staff>>, ph: typeof host, cashier: typeof host;

  it('a family books and pays online; the booth pulls the appointment', async () => {
    const slot = (await cloud.call('GET', `/api/slots?eventId=${cloud.sn.eventId}&date=${cloud.today}`)).json[0];
    online = (await cloud.call('POST', '/api/bookings', { slotId: slot.id, packageCode: 'famille', fullName: 'Famille Ndiaye', phone: '76 555 44 33', phoneCountry: 'SN' })).json;
    cloud.cinet.state.next = { status: 'succeeded', amountXof: 10_000, operatorRef: 'W1', raw: {} };
    await cloud.call('POST', `/api/bookings/${online.token}/pay`, { method: 'wave' });
    await cloud.call('GET', `/api/bookings/${online.token}`);

    await tick();
    const local = booth.booth.db.select().from(schema.bookings).where(eq(schema.bookings.code, online.code)).get()!;
    expect(local).toMatchObject({ status: 'confirmed', source: 'online', boothId: cloud.sn.boothId, packageId: 'pkg_famille_SN' });
  });

  it('host checks them in; photographer shoots; photos reach the cloud', async () => {
    host = await staff('host');
    expect((await host.post('/api/queue/check-in', { code: `https://web.test/b/${online.token}?code=${online.code}` })).status).toBe(201);
    const [entry] = await (await host.get('/api/queue')).json();
    const session = await (await host.post(`/api/queue/${entry.id}/send`)).json();
    ph = await staff('photographer');
    await ph.post(`/api/sessions/${session.id}/arm`);
    const cam = [...booth.booth.cameras.values()][0]!;
    await ph.post(`/api/cameras/${cam.cameraId}/shutter`);
    await ph.post(`/api/cameras/${cam.cameraId}/shutter`);
    await cam.idle();
    await ph.post(`/api/sessions/${session.id}/complete`);

    await tick();
    const photos = await cloud.db.query('select seq, thumb_key, preview_key, deliverable_key, upload_status from photos order by seq');
    expect(photos).toHaveLength(2);
    expect(photos.every((p: any) => p.thumb_key && p.preview_key && p.deliverable_key && p.upload_status === 'done')).toBe(true);
    const [b] = await cloud.db.query('select status, checked_in_at from bookings where public_token = $1', [online.token]);
    expect(b).toMatchObject({ status: 'shot_complete' });
    expect(b!.checked_in_at).toBeGreaterThan(0);
  });

  it('cashier: the online payment is credit; the Famille package costs nothing more', async () => {
    cashier = await staff('cashier');
    const [fam] = await (await cashier.get('/api/pos/families')).json();
    expect(fam).toMatchObject({ familyName: 'Famille Ndiaye', prepaidXof: 10_000, prepaidPackageId: 'pkg_famille_SN' });
    const photos = (await (await cashier.get(`/api/pos/families/${fam.bookingId}/photos`)).json()).map((p: any) => p.id);
    const [a, b] = photos;
    const slots = [['8x10', a], ['5x7', a], ['5x7', b], ['4x6', a], ['4x6', b], ['wallet4', a], ['wallet4', b]].map(([size, photoId]) => ({ size, photoId }));
    const order = await (await cashier.post('/api/pos/orders', { bookingId: fam.bookingId, lines: [{ packageId: 'pkg_famille_SN', qty: 1 }], digitalPhotoIds: [b], printSlots: slots })).json();
    expect(order).toMatchObject({ subtotalXof: 10_000, creditAppliedXof: 10_000, totalXof: 0, vatXof: 0 });
    expect((await cashier.post(`/api/pos/orders/${order.id}/pay`, { method: 'prepaid' })).status).toBe(200);
    expect((await (await cashier.get('/api/pos/families')).json())).toHaveLength(0);
  });

  it('the family opens the gallery with the PIN: the included photo downloads, the other can be bought', async () => {
    await tick(); // pushes the booth order (its digital line unlocks photo #2)
    const session = (await cloud.call('POST', `/api/gallery/${online.token}/login`, { pin: online.pin })).json.session;
    const g = (await cloud.call('GET', `/api/gallery/${online.token}/photos`, undefined, { Authorization: `Bearer ${session}` })).json;
    expect(g.photos.map((p: any) => [p.seq, p.unlocked])).toEqual([[1, false], [2, true]]);
    const file = await fetch(g.photos[1].downloadUrl);
    expect(file.headers.get('content-type')).toBe('image/jpeg');
    expect((await file.arrayBuffer()).byteLength).toBeGreaterThan(10_000);
    const thumb = await fetch(g.photos[0].thumbUrl);
    expect(thumb.headers.get('content-type')).toBe('image/webp');
  });
});

describe('booked a minute ago', () => {
  it('the host finds it at once: an unknown code triggers a pull', async () => {
    const slot = (await cloud.call('GET', `/api/slots?eventId=${cloud.sn.eventId}&date=${cloud.today}`)).json[2];
    const fresh = (await cloud.call('POST', '/api/bookings', { slotId: slot.id, packageCode: 'numerique', fullName: 'Famille Fall', phone: '77 222 33 44', phoneCountry: 'SN' })).json;
    cloud.cinet.state.next = { status: 'succeeded', amountXof: 5_000, raw: {} };
    await cloud.call('POST', `/api/bookings/${fresh.token}/pay`, { method: 'wave' });
    await cloud.call('GET', `/api/bookings/${fresh.token}`);
    const host = await staff('host');
    expect((await host.post('/api/queue/check-in', { code: fresh.code })).status).toBe(201); // no tick before
  });
});

describe('walk-in paying by Wave at the cashier, through the cloud', () => {
  it('starts the payment, shows the QR on the kiosk, and the verify button settles it', async () => {
    const host = await staff('host');
    const w = await (await host.post('/api/queue/walk-in', { fullName: 'Famille Sarr', phone: '77 111 22 33', country: 'SN' })).json();
    expect(w.galleryUrl).toMatch(/^https:\/\/web\.test\/b\/[A-Za-z0-9_-]{22}$/);
    const queue = await (await host.get('/api/queue')).json();
    expect(queue.map((e: any) => e.name)).toEqual(['Famille Fall', 'Famille Sarr']); // appointment first
    const entry = queue[1];
    const session = await (await host.post(`/api/queue/${entry.id}/send`)).json();
    const ph = await staff('photographer');
    await ph.post(`/api/sessions/${session.id}/arm`);
    const cam = [...booth.booth.cameras.values()][0]!;
    await ph.post(`/api/cameras/${cam.cameraId}/shutter`);
    await cam.idle();
    await ph.post(`/api/sessions/${session.id}/complete`);

    const cashier = await staff('cashier');
    const [fam] = await (await cashier.get('/api/pos/families')).json();
    expect(fam.prepaidXof).toBe(0);
    const [photo] = await (await cashier.get(`/api/pos/families/${fam.bookingId}/photos`)).json();
    const order = await (await cashier.post('/api/pos/orders', { bookingId: fam.bookingId, lines: [{ packageId: 'pkg_numerique_SN', qty: 1 }], digitalPhotoIds: [photo.id], printSlots: [] })).json();

    cloud.cinet.state.next = { status: 'pending', raw: {} };
    const start = await (await cashier.post(`/api/pos/orders/${order.id}/momo`, { method: 'wave', phone: '77 111 22 33' })).json();
    expect(start).toMatchObject({ kind: 'redirect' });
    expect(start.url).toMatch(/^https:\/\/pay\.test\//);
    expect((await (await cashier.get(`/api/pos/payments/${start.paymentId}`)).json()).status).toBe('pending');
    expect((await cashier.post(`/api/pos/orders/${order.id}/momo`, { method: 'mtn_momo' })).status).toBe(400); // not in Senegal

    // Webhook stuck somewhere: the customer shows the SMS, the cashier verifies.
    cloud.cinet.state.next = { status: 'succeeded', amountXof: 5_000, operatorRef: 'WV-998', raw: {} };
    const v = await (await cashier.post(`/api/pos/payments/${start.paymentId}/verify`, { operatorRef: 'WV-998' })).json();
    expect(v).toEqual({ status: 'succeeded', operatorRef: 'WV-998', operatorMismatch: false });
    const local = booth.booth.db.select().from(schema.orders).where(eq(schema.orders.id, order.id)).get()!;
    expect(local.status).toBe('paid');
    expect(booth.booth.db.select().from(schema.payments).where(eq(schema.payments.id, start.paymentId)).get()).toMatchObject({ status: 'succeeded', provider: 'cinetpay' });

    // Next sync: the walk-in exists in the cloud (code 9xxxxx) and the provider payment row is not echoed back as a refusal.
    await tick();
    const [cb] = await cloud.db.query('select code, status from bookings where id = $1', [fam.bookingId]);
    expect(cb).toMatchObject({ status: 'completed' });
    expect(cb!.code).toMatch(/^9\d{5}$/);
    const stuck = booth.booth.db.select().from(schema.syncOutbox).all();
    expect(stuck.filter((r) => r.attempts > 0)).toEqual([]);
  });
});
