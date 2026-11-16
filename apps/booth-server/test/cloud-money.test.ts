import { createServer } from 'node:net';
import { serve } from '@hono/node-server';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@pmp/db';
import { makeCloud } from '../../cloud/test/harness';
import { makeBooth } from './harness';

// Audit regressions around money, with the real cloud API (Postgres) and a booth syncing with it.
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
  const opener = await staff('cashier');
  await opener.post('/api/pos/drawer/open', { openingFloatXof: 0 });
});
afterAll(async () => { await booth.close(); server.close(); await cloud.close(); });

const db = () => booth.booth.db;
const tick = () => booth.booth.sync!.tick().then(() => expect(booth.booth.sync!.lastError).toBeNull());
async function staff(role: 'host' | 'photographer' | 'cashier') {
  const c = booth.client();
  await c.login((await booth.addUser(role)).id);
  return c;
}
const pending = () => { cloud.cinet.state.next = { status: 'pending', raw: {} }; };
const customerPaid = (amountXof: number, operatorRef: string) => { cloud.cinet.state.next = { status: 'succeeded', amountXof, operatorRef, raw: {} }; };

/** A walk-in family, photographed, now at the cashier. `cart()` builds a 5 000 F Numérique order. */
async function familyAtCashier(name: string, phone: string) {
  const host = await staff('host');
  const w = await (await host.post('/api/queue/walk-in', { fullName: name, phone, country: 'SN' })).json();
  const entry = (await (await host.get('/api/queue')).json()).find((e: any) => e.bookingCode === w.bookingCode);
  const session = await (await host.post(`/api/queue/${entry.id}/send`)).json();
  const ph = await staff('photographer');
  await ph.post(`/api/sessions/${session.id}/arm`);
  await ph.post(`/api/cameras/${[...booth.booth.cameras.values()][0]!.cameraId}/shutter`);
  await ph.post(`/api/sessions/${session.id}/complete`);
  const cashier = await staff('cashier');
  const bookingId = entry.bookingId as string;
  const [photo] = await (await cashier.get(`/api/pos/families/${bookingId}/photos`)).json();
  const cart = async () => (await cashier.post('/api/pos/orders', { bookingId, lines: [{ packageId: 'pkg_numerique_SN', qty: 1 }], digitalPhotoIds: [photo.id], printSlots: [] })).json();
  const family = async () => (await (await cashier.get('/api/pos/families')).json()).find((f: any) => f.bookingId === bookingId);
  return { bookingId, token: String(w.galleryUrl).split('/b/')[1]!, pin: w.pin as string, photoId: photo.id as string, cashier, cart, family };
}
const paymentsOf = (orderId: string) => db().select().from(schema.payments).where(eq(schema.payments.orderId, orderId)).all();
const bookingStatus = (id: string) => db().select().from(schema.bookings).where(eq(schema.bookings.id, id)).get()!.status;

describe('never charge twice', () => {
  it('cash is refused when the phone payment already went through', async () => {
    const f = await familyAtCashier('Famille Une Fois', '77 300 00 01');
    const order = await f.cart();
    pending();
    expect((await f.cashier.post(`/api/pos/orders/${order.id}/momo`, { method: 'wave' })).status).toBe(201);
    // The customer pays on the phone; the cashier, seeing nothing yet, closes the dialog and takes cash.
    customerPaid(5_000, 'WV-ONCE');
    const cash = await f.cashier.post(`/api/pos/orders/${order.id}/pay`, { method: 'cash', tenderedXof: 5_000 });
    expect([cash.status, (await cash.json()).error]).toEqual([409, 'order_paid']);
    expect(paymentsOf(order.id).map((p) => [p.method, p.status, p.providerTxId])).toEqual([['wave', 'succeeded', 'WV-ONCE']]);
    expect(bookingStatus(f.bookingId)).toBe('completed');
  });

  it('a second Mobile Money attempt is refused when the first one succeeded', async () => {
    const f = await familyAtCashier('Famille Second Essai', '77 300 00 02');
    const order = await f.cart();
    pending();
    await f.cashier.post(`/api/pos/orders/${order.id}/momo`, { method: 'wave' });
    customerPaid(5_000, 'WV-FIRST');
    const again = await f.cashier.post(`/api/pos/orders/${order.id}/momo`, { method: 'orange_money' });
    expect([again.status, (await again.json()).error]).toEqual([409, 'order_paid']);
    expect(paymentsOf(order.id)).toHaveLength(1);
    expect(bookingStatus(f.bookingId)).toBe('completed');
  });

  it('a payment that lands on a replaced cart becomes credit for the family', async () => {
    const f = await familyAtCashier('Famille Tardive', '77 300 00 03');
    const first = await f.cart();
    pending();
    await f.cashier.post(`/api/pos/orders/${first.id}/momo`, { method: 'wave' });
    await f.cart();   // the cashier rebuilds the cart: the first order is void, its payment link still exists
    await tick();     // the void reaches the cloud
    customerPaid(5_000, 'WV-LATE');
    await cloud.call('POST', '/api/webhooks/cinetpay', { cpm_trans_id: paymentsOf(first.id)[0]!.id });
    expect((await cloud.db.query('select status from orders where id = $1', [first.id]))[0]!.status).toBe('void');
    await tick();     // the booth learns about the money

    expect((await f.family()).prepaidXof).toBe(5_000);
    const next = await f.cart();
    expect(next).toMatchObject({ subtotalXof: 5_000, creditAppliedXof: 5_000, totalXof: 0 });
    expect((await f.cashier.post(`/api/pos/orders/${next.id}/pay`, { method: 'prepaid' })).status).toBe(200);
    expect(bookingStatus(f.bookingId)).toBe('completed');
  });

  it('a payment request that never reached the cloud is closed as failed, and cash then works', async () => {
    const f = await familyAtCashier('Famille Perdue', '77 300 00 04');
    const order = await f.cart();
    // What /momo leaves behind when the network dies before the request arrives.
    db().insert(schema.payments).values({ id: 'lost-request-1', orderId: order.id, method: 'wave', idempotencyKey: 'lost-request-1', amountXof: 5_000, status: 'pending' }).run();
    expect((await (await f.cashier.get('/api/pos/payments/lost-request-1')).json()).status).toBe('failed');
    expect((await f.cashier.post(`/api/pos/orders/${order.id}/pay`, { method: 'cash', tenderedXof: 5_000 })).status).toBe(200);
  });
});

describe('online orders stay the cloud\'s', () => {
  it('building a cart at the till does not cancel a gallery purchase being paid', async () => {
    const f = await familyAtCashier('Famille Galerie', '77 300 00 05');
    await tick(); // booking and photos reach the cloud
    const session = (await cloud.call('POST', `/api/gallery/${f.token}/login`, { pin: f.pin })).json.session;
    pending();
    const buy = (await cloud.call('POST', `/api/gallery/${f.token}/buy`, { photoIds: [f.photoId], method: 'wave' }, { Authorization: `Bearer ${session}` })).json;
    expect(buy.totalXof).toBe(5_000);
    await tick(); // the open online order arrives at the booth

    const online = () => db().select().from(schema.orders).where(and(eq(schema.orders.bookingId, f.bookingId), eq(schema.orders.channel, 'online'))).get()!;
    expect(online().status).toBe('open');
    await f.cart(); // the cashier starts a sale for the same family
    expect(online().status).toBe('open');
    await tick();
    expect((await cloud.db.query('select status from orders where id = $1', [online().id]))[0]!.status).toBe('open');

    // The family finishes paying on the phone: the photo unlocks, and the till did not "deliver" their online order.
    customerPaid(5_000, 'WV-GAL');
    await cloud.call('POST', '/api/webhooks/cinetpay', { cpm_trans_id: buy.paymentId });
    await tick();
    expect(online().status).toBe('paid');
    expect(bookingStatus(f.bookingId)).toBe('shot_complete'); // still at the cashier for their booth order
    expect((await f.family()).prepaidXof).toBe(0);            // a gallery purchase is not credit
    const g = (await cloud.call('GET', `/api/gallery/${f.token}/photos`, undefined, { Authorization: `Bearer ${session}` })).json;
    expect(g.photos[0].unlocked).toBe(true);
  });
});
