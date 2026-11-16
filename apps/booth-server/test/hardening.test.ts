import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, writeSynced } from '@pmp/db';
import { CloudError, type CloudClient } from '../src/cloud/client';
import { CloudSync } from '../src/cloud/sync';
import { uuidv7 } from '../src/ids';
import { prepaidCredit } from '../src/pos/fulfil';
import { parseInches } from '../src/print/layout';
import { makeBooth } from './harness';

// Regression tests for the audit: each case failed (or could not be expressed) before the fix.
let t: Awaited<ReturnType<typeof makeBooth>>;
beforeAll(async () => { t = await makeBooth(); });
afterAll(async () => { await t.close(); });

async function staff(role: 'host' | 'photographer' | 'cashier' | 'supervisor') {
  const c = t.client();
  await c.login((await t.addUser(role)).id);
  return c;
}
const until = async (fn: () => boolean) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 25)); };
const cam = () => [...t.booth.cameras.values()][0]!;

/** Walk-in → shot (n photos) → finished; returns ids. `settle` false = finish at once, without waiting for previews. */
async function shootFamily(name: string, phone: string, n = 1, settle = true) {
  const host = await staff('host');
  const w = await (await host.post('/api/queue/walk-in', { fullName: name, phone, country: 'SN' })).json();
  const entry = (await (await host.get('/api/queue')).json()).find((e: any) => e.bookingCode === w.bookingCode);
  const session = await (await host.post(`/api/queue/${entry.id}/send`)).json();
  const ph = await staff('photographer');
  await ph.post(`/api/sessions/${session.id}/arm`);
  for (let i = 0; i < n; i++) await ph.post(`/api/cameras/${cam().cameraId}/shutter`);
  if (settle) await cam().idle();
  expect((await ph.post(`/api/sessions/${session.id}/complete`)).status).toBe(200);
  return { bookingId: entry.bookingId as string, sessionId: session.id as string, ph, host };
}
const photosOf = (sessionId: string) => t.booth.db.select().from(schema.photos).where(eq(schema.photos.sessionId, sessionId)).orderBy(schema.photos.seq).all();

describe('HTTP edges', () => {
  it('answers malformed JSON with 400 and unknown API paths with JSON 404', async () => {
    const bad = await fetch(`${t.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    expect([bad.status, (await bad.json()).error]).toEqual([400, 'invalid_request']);
    const missing = await fetch(`${t.base}/api/does-not-exist`);
    expect([missing.status, missing.headers.get('content-type')]).toEqual([404, 'application/json; charset=utf-8']);
  });

  it('accepts custom print sizes in either order', () => {
    expect(parseInches('custom', '15x10')).toEqual([10, 15]);
    expect(parseInches('custom', '10x15')).toEqual([10, 15]);
    expect(() => parseInches('custom', '14x20')).toThrow('custom_size_out_of_range');
  });
});

describe('queue', () => {
  it('a family marked "left" can rejoin; the same walk-in is not queued twice', async () => {
    const host = await staff('host');
    const c = writeSynced(t.booth.db, schema.customers, { id: uuidv7(), phone: '+221770001111', fullName: 'Famille Retour' });
    const b = writeSynced(t.booth.db, schema.bookings, {
      id: uuidv7(), code: '444444', publicToken: uuidv7(), pinHash: 'x', eventId: 'e', boothId: t.boothId, customerId: c.id, source: 'online', status: 'confirmed',
    });
    const first = await (await host.post('/api/queue/check-in', { code: b.code })).json();
    await host.post(`/api/queue/${first.entryId}/left`);
    expect((await (await host.get('/api/queue')).json()).some((e: any) => e.bookingCode === '444444')).toBe(false);
    const back = await host.post('/api/queue/check-in', { code: b.code });
    expect([back.status, (await back.json()).alreadyCheckedIn]).toEqual([201, false]);
    expect((await (await host.get('/api/queue')).json()).some((e: any) => e.bookingCode === '444444')).toBe(true);

    const walkIn = { fullName: 'Famille Double', phone: '77 000 22 22', country: 'SN' };
    const [a, d] = await Promise.all([host.post('/api/queue/walk-in', walkIn), host.post('/api/queue/walk-in', walkIn)]);
    expect([a.status, d.status].sort()).toEqual([201, 409]);
    expect((await (await host.get('/api/queue')).json()).filter((e: any) => e.name === 'Famille Double')).toHaveLength(1);
  });
});

describe('photos', () => {
  it('finishing right after the last shot still sends every photo to the gallery queue', async () => {
    const { sessionId } = await shootFamily('Famille Rapide', '77 000 33 33', 3, false);
    const photos = photosOf(sessionId);
    expect(photos.map((p) => p.ingestStatus)).toEqual(['ready', 'ready', 'ready']);
    for (const p of photos) {
      expect(t.booth.db.select().from(schema.uploadJobs).where(eq(schema.uploadJobs.photoId, p.id)).all()).toHaveLength(3);
    }
  });

  it('a hidden photo shown again is uploaded; a sold photo cannot be hidden', async () => {
    const host = await staff('host');
    const w = await (await host.post('/api/queue/walk-in', { fullName: 'Famille Cache', phone: '77 000 44 44', country: 'SN' })).json();
    const entry = (await (await host.get('/api/queue')).json()).find((e: any) => e.bookingCode === w.bookingCode);
    const session = await (await host.post(`/api/queue/${entry.id}/send`)).json();
    const ph = await staff('photographer');
    await ph.post(`/api/sessions/${session.id}/arm`);
    await ph.post(`/api/cameras/${cam().cameraId}/shutter`);
    await ph.post(`/api/cameras/${cam().cameraId}/shutter`);
    await cam().idle();
    const [p1, p2] = photosOf(session.id);
    await ph.post(`/api/photos/${p1!.id}/hidden`, { hidden: true });
    await ph.post(`/api/sessions/${session.id}/complete`);
    const jobs = (id: string) => t.booth.db.select().from(schema.uploadJobs).where(eq(schema.uploadJobs.photoId, id)).all();
    expect(jobs(p1!.id)).toHaveLength(0);                       // hidden at the end of the shoot
    await ph.post(`/api/photos/${p1!.id}/hidden`, { hidden: false });
    expect(jobs(p1!.id).map((j) => j.status)).toEqual(['queued', 'queued', 'queued']);

    const cashier = await staff('cashier');
    const order = await (await cashier.post('/api/pos/orders', { bookingId: entry.bookingId, lines: [{ packageId: 'pkg_numerique_SN', qty: 1 }], digitalPhotoIds: [p2!.id], printSlots: [] })).json();
    await cashier.post('/api/pos/drawer/open', { openingFloatXof: 0 });
    expect((await cashier.post(`/api/pos/orders/${order.id}/pay`, { method: 'cash', tenderedXof: 5_000 })).status).toBe(200);
    const hide = await ph.post(`/api/photos/${p2!.id}/hidden`, { hidden: true });
    expect([hide.status, (await hide.json()).error]).toEqual([409, 'photo_sold']);
  });
});

describe('printing', () => {
  it('a package line gives no free print; a failed job can be retried', async () => {
    const { bookingId, sessionId } = await shootFamily('Famille Tirage', '77 000 55 55');
    const [photo] = photosOf(sessionId);
    const cashier = await staff('cashier');
    t.printer.fail = 'printer_not_found:DS620'; // printer switched off
    const order = await (await cashier.post('/api/pos/orders', {
      bookingId, lines: [{ packageId: 'pkg_tirages_10x15_SN', qty: 1 }], digitalPhotoIds: [], printSlots: [{ size: '4x6', photoId: photo!.id }, { size: '4x6', photoId: photo!.id }],
    })).json();
    expect((await cashier.post(`/api/pos/orders/${order.id}/pay`, { method: 'cash', tenderedXof: 1_500 })).status).toBe(200);
    const jobOf = () => t.booth.db.select().from(schema.printJobs).innerJoin(schema.orderItems, eq(schema.orderItems.id, schema.printJobs.orderItemId))
      .where(eq(schema.orderItems.orderId, order.id)).get()!.print_jobs;
    await until(() => jobOf().status === 'failed');
    expect(jobOf()).toMatchObject({ status: 'failed', copies: 2 });

    const bundle = t.booth.db.select().from(schema.orderItems).where(and(eq(schema.orderItems.orderId, order.id), eq(schema.orderItems.kind, 'bundle'))).get()!;
    const free = await cashier.post('/api/print-jobs', { orderItemId: bundle.id, photoId: photo!.id, size: '8x10', copies: 1 });
    expect([free.status, (await free.json()).error]).toEqual([409, 'not_a_print_item']);

    t.printer.fail = null; // printer back on
    const before = t.printed.length;
    expect((await cashier.post(`/api/print-jobs/${jobOf().id}/retry`)).status).toBe(200);
    await until(() => jobOf().status === 'done');
    expect(t.printed.length).toBe(before + 1);
    expect((await cashier.post(`/api/print-jobs/${jobOf().id}/retry`)).status).toBe(409); // only failed jobs
  });
});

describe('credit: money received minus goods delivered', () => {
  it('counts a payment that landed on a replaced (void) order, and an overpayment', async () => {
    const { bookingId } = await shootFamily('Famille Credit', '77 000 66 66');
    const db = t.booth.db;
    const order = (status: 'open' | 'paid' | 'void', subtotalXof: number) =>
      writeSynced(db, schema.orders, { id: uuidv7(), bookingId, boothId: t.boothId, channel: 'booth', status, subtotalXof, totalXof: subtotalXof, vatBp: 1800 });
    const pay = (orderId: string, amountXof: number, status: 'succeeded' | 'pending' = 'succeeded') =>
      db.insert(schema.payments).values({ id: uuidv7(), orderId, method: 'wave', idempotencyKey: uuidv7(), amountXof, status }).run();
    const bundle = (orderId: string) => writeSynced(db, schema.orderItems, { id: uuidv7(), orderId, kind: 'bundle', qty: 1, unitPriceXof: 0, lineTotalXof: 0 });

    expect(prepaidCredit(db, bookingId).creditXof).toBe(0);
    const replaced = order('void', 5_000); bundle(replaced.id);
    pay(replaced.id, 5_000, 'pending');
    expect(prepaidCredit(db, bookingId).creditXof).toBe(0);        // not money yet
    pay(replaced.id, 5_000);                                       // the customer paid the old link after all
    expect(prepaidCredit(db, bookingId).creditXof).toBe(5_000);

    const sold = order('paid', 7_500); bundle(sold.id);
    pay(sold.id, 2_500);                                           // the difference, collected at the till
    expect(prepaidCredit(db, bookingId).creditXof).toBe(0);        // 7 500 received, 7 500 delivered
    pay(sold.id, 2_500);                                           // paid twice by mistake
    expect(prepaidCredit(db, bookingId).creditXof).toBe(2_500);
  });
});

describe('cloud sync engine (stubbed cloud)', () => {
  /** A PUT target standing in for cloud storage. */
  async function storageServer() {
    const got: string[] = [];
    const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => { got.push(req.url ?? ''); res.end('ok'); }); }).listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    return { got, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => srv.close() };
  }
  const stub = (handlers: { get?: (p: string) => unknown; post?: (p: string, b: any) => unknown }): CloudClient => ({
    get: async (p) => handlers.get!(p) as never,
    post: async (p, b) => handlers.post!(p, b) as never,
  });

  it('keeps retrying uploads through a long outage, and gives up only on files the cloud rejects', async () => {
    const { sessionId } = await shootFamily('Famille Upload', '77 000 77 77', 2);
    const [p1, p2] = photosOf(sessionId);
    const U = schema.uploadJobs;
    const db = t.booth.db;
    db.delete(U).run();
    db.insert(U).values([
      { id: 'u1', photoId: p1!.id, kind: 'thumb', priority: 10, status: 'queued', createdAt: 1 },
      { id: 'u2', photoId: p2!.id, kind: 'thumb', priority: 5, status: 'queued', createdAt: 2 },
    ]).run();
    const store = await storageServer();
    let down = true;
    let reject: string | null = null;
    const sync = new CloudSync({ db, boothId: t.boothId, sessionsDir: `${t.root}/Sessions`, client: stub({
      post: (p, b) => {
        if (down) throw new CloudError(0, 'cloud_unreachable');
        if (p === '/api/sync/upload-url' && b.photoId === reject) throw new CloudError(404, 'photo_not_found');
        return p === '/api/sync/upload-url' ? { url: `${store.url}/${b.photoId}`, headers: {} } : { ok: true };
      },
    }) });
    try {
      for (let i = 0; i < 8; i++) await sync.uploads().catch(() => {});   // far more rounds than the old 5-try limit
      expect(db.select().from(U).where(eq(U.id, 'u1')).get()).toMatchObject({ status: 'queued', attempts: 8 });
      expect(db.select().from(U).where(eq(U.id, 'u2')).get()).toMatchObject({ status: 'queued', attempts: 0 }); // the line was down: not even tried

      down = false;
      reject = p1!.id; // the cloud does not know this photo
      expect(await sync.uploads()).toBe(1);
      expect(db.select().from(U).where(eq(U.id, 'u1')).get()).toMatchObject({ status: 'failed', lastError: 'photo_not_found' });
      expect(db.select().from(U).where(eq(U.id, 'u2')).get()!.status).toBe('done'); // not blocked by the rejected one
      expect(store.got).toEqual([`/${p2!.id}`]);
    } finally {
      store.close();
    }
  });

  it('a pull stores what it can: missing references are cleared, an unusable row is skipped, the cursor moves on', async () => {
    const db = t.booth.db;
    const paid: string[] = [];
    const base = { created_at: 1, updated_at: 1, deleted_at: null };
    const rows = {
      customers: [{ id: 'pc-1', phone: '+221770009999', country: 'SN', full_name: 'Famille Tiree', email: null, locale: 'fr', whatsapp_opt_in: true, server_seq: 11, ...base }],
      bookings: [{
        id: 'pb-1', code: '123123', public_token: 'pull-token-1', pin_hash: 'h', event_id: 'e', booth_id: t.boothId, slot_id: null, customer_id: 'pc-1', package_id: null,
        source: 'online', status: 'checked_in', party_size: 2, hold_expires_at: null, checked_in_at: 5, checked_in_by: 'user-from-the-old-pc', notes: null, server_seq: 12, ...base,
      }],
      orders: [
        { id: 'po-orphan', booking_id: 'no-such-booking', booth_id: t.boothId, channel: 'online', cashier_id: null, status: 'paid', subtotal_xof: 1, credit_applied_xof: 0, total_xof: 1, vat_bp: 1800, vat_xof: 0, paid_at: 1, server_seq: 13, ...base },
        { id: 'po-1', booking_id: 'pb-1', booth_id: t.boothId, channel: 'online', cashier_id: 'cashier-from-the-old-pc', status: 'paid', subtotal_xof: 10_000, credit_applied_xof: 0, total_xof: 10_000, vat_bp: 1800, vat_xof: 1525, paid_at: 1, server_seq: 14, ...base },
      ],
      order_items: [],
      payments: [{
        id: 'pp-1', order_id: 'po-1', method: 'cash', provider: null, idempotency_key: 'pp-1', provider_tx_id: null, amount_xof: 10_000, payer_phone: null, status: 'succeeded',
        received_by: 'cashier-from-the-old-pc', drawer_session_id: 'drawer-from-the-old-pc', confirmed_at: 1, operator_ref: null, server_seq: 15, ...base,
      }],
    };
    const sync = new CloudSync({ db, boothId: t.boothId, sessionsDir: `${t.root}/Sessions`, client: stub({ get: () => ({ rows, cursor: 15 }) }), onPulled: (r) => paid.push(...r.paidOrders.map((o) => o.orderId)) });
    await sync.pull();
    expect(db.select().from(schema.bookings).where(eq(schema.bookings.id, 'pb-1')).get()).toMatchObject({ status: 'checked_in', checkedInBy: null });
    expect(db.select().from(schema.orders).where(eq(schema.orders.id, 'po-1')).get()).toMatchObject({ status: 'paid', cashierId: null });
    expect(db.select().from(schema.payments).where(eq(schema.payments.id, 'pp-1')).get()).toMatchObject({ receivedBy: null, drawerSessionId: null });
    expect(db.select().from(schema.orders).where(eq(schema.orders.id, 'po-orphan')).get()).toBeUndefined();
    expect(db.select().from(schema.settings).where(eq(schema.settings.key, 'sync.cursor')).get()!.value).toBe('15');
    expect(paid).toEqual([]); // an online order is not delivered by the booth
  });

  it('an order the cloud settled while nobody was polling is delivered by the pull, exactly once', async () => {
    const { bookingId, sessionId } = await shootFamily('Famille Pull', '77 000 88 88');
    const [photo] = photosOf(sessionId);
    const cashier = await staff('cashier');
    const order = await (await cashier.post('/api/pos/orders', {
      bookingId, lines: [{ packageId: 'pkg_tirages_10x15_SN', qty: 1 }], digitalPhotoIds: [], printSlots: [{ size: '4x6', photoId: photo!.id }, { size: '4x6', photoId: photo!.id }],
    })).json();
    const db = t.booth.db;
    db.insert(schema.payments).values({ id: 'pull-pay-1', orderId: order.id, method: 'wave', provider: 'cinetpay', idempotencyKey: 'pull-pay-1', amountXof: 1_500, status: 'pending' }).run();
    const cloudOrder = { id: order.id, booking_id: bookingId, booth_id: t.boothId, channel: 'booth', status: 'paid', paid_at: 99, server_seq: 21 };
    const cloudPay = { id: 'pull-pay-1', order_id: order.id, method: 'wave', provider: 'cinetpay', status: 'succeeded', confirmed_at: 99, operator_ref: 'WV-PULL', server_seq: 22 };
    const delivered: string[] = [];
    const sync = new CloudSync({
      db, boothId: t.boothId, sessionsDir: `${t.root}/Sessions`,
      client: stub({ get: () => ({ rows: { orders: [cloudOrder], payments: [cloudPay] }, cursor: 22 }) }),
      onPulled: (r) => delivered.push(...r.paidOrders.map((o) => o.orderId)),
    });
    await sync.pull();
    await sync.pull(); // the same rows again (echo): nothing more happens

    expect(delivered).toEqual([order.id]);
    expect(db.select().from(schema.orders).where(eq(schema.orders.id, order.id)).get()!.status).toBe('paid');
    expect(db.select().from(schema.bookings).where(eq(schema.bookings.id, bookingId)).get()!.status).toBe('completed');
    expect(db.select().from(schema.payments).where(eq(schema.payments.id, 'pull-pay-1')).get()).toMatchObject({ status: 'succeeded', providerTxId: 'WV-PULL' });
    const jobs = db.select().from(schema.printJobs).innerJoin(schema.orderItems, eq(schema.orderItems.id, schema.printJobs.orderItemId))
      .where(eq(schema.orderItems.orderId, order.id)).all();
    expect(jobs).toHaveLength(1); // one print line → one job, not two
    expect((await (await cashier.get('/api/pos/families')).json()).some((f: any) => f.bookingId === bookingId)).toBe(false);
  });
});
