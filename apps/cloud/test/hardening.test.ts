import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeCloud } from './harness';

let c: Awaited<ReturnType<typeof makeCloud>>;
let slots: Array<{ id: string }> = [];
beforeAll(async () => {
  c = await makeCloud();
  slots = (await c.call('GET', `/api/slots?eventId=${c.sn.eventId}&date=${c.today}`)).json;
});
afterAll(async () => { await c.close(); });

const sn = () => c.booth(c.sn.token);
const bj = () => c.booth(c.bj.token);
const book = (slot: number, phone: string, extra: object = {}) =>
  c.call('POST', '/api/bookings', { slotId: slots[slot]!.id, packageCode: 'numerique', fullName: 'Famille Test', phone, phoneCountry: 'SN', ...extra });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('sync ordering', () => {
  it('a writer that commits late blocks later sequence numbers (no row can be skipped by a pull cursor)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inserted!: () => void;
    const didInsert = new Promise<void>((r) => (inserted = r));
    let aSeq = 0;
    const a = c.db.tx(async (t) => {
      const [r] = await t.query<{ server_seq: number }>(
        `insert into customers (id, phone, created_at, updated_at) values ('seq-a', '+221770000009', 1, 1) returning server_seq`);
      aSeq = r!.server_seq;
      inserted();
      await gate; // still uncommitted
    });
    await didInsert;
    let bDone = false;
    const b = c.db.query<{ server_seq: number }>(
      `insert into customers (id, phone, created_at, updated_at) values ('seq-b', '+221770000008', 1, 1) returning server_seq`)
      .then((r) => { bDone = true; return r[0]!.server_seq; });
    await sleep(300);
    expect(bDone).toBe(false); // B waits for A's commit instead of jumping ahead
    release();
    await a;
    expect(await b).toBeGreaterThan(aSeq);
  });
});

describe('booth push: isolation and ownership', () => {
  const walkIn = { id: 'h-bk-1', code: '900001', publicToken: 'h-token-1', pinHash: 'h', eventId: 'e', source: 'walk_in', status: 'checked_in', partySize: 2, createdAt: 1, updatedAt: 1 };
  const order = { id: 'h-ord-1', bookingId: 'h-bk-1', channel: 'booth', status: 'open', subtotalXof: 5_000, totalXof: 5_000, vatBp: 1800, vatXof: 763, createdAt: 1, updatedAt: 1 };

  it('refuses a bad row without blocking the rest of the batch', async () => {
    const r = (await c.call('POST', '/api/sync/push', { rows: [
      { tbl: 'customers', row: { id: 'h-cu-1', phone: '+221770000101', fullName: 'Un', createdAt: 1, updatedAt: 1 } },
      { tbl: 'bookings', row: { ...walkIn, customerId: 'h-cu-1', boothId: c.sn.boothId } },
      { tbl: 'bookings', row: { ...walkIn, id: 'h-bk-dup', publicToken: 'h-token-2', customerId: 'h-cu-1', boothId: c.sn.boothId } }, // same code on this booth
      { tbl: 'bookings', row: { ...walkIn, id: 'h-bk-bad', code: '900002', publicToken: 'h-token-3', customerId: 'h-cu-1', boothId: c.sn.boothId, partySize: 'many' } }, // wrong type
      { tbl: 'orders', row: { ...order, boothId: c.sn.boothId } },
      { tbl: 'order_items', row: { id: 'h-oi-1', orderId: 'h-ord-1', kind: 'bundle', qty: 1, unitPriceXof: 5_000, lineTotalXof: 5_000, createdAt: 1, updatedAt: 1 } },
      { tbl: 'photos', row: { id: 'h-ph-1', sessionId: 's', bookingId: 'h-bk-1', seq: 1, originalName: 'a', fileName: 'a', sha256: 'x', ingestStatus: 'ready', createdAt: 1, updatedAt: 1 } },
    ] }, sn())).json;
    expect(r).toEqual({ accepted: 5, refused: [2, 3] });
    expect((await c.db.query('select id from bookings where id like $1 order by id', ['h-bk-%'])).map((x) => x.id)).toEqual(['h-bk-1']);
    expect(await c.db.query('select id from photos where id = $1', ['h-ph-1'])).toHaveLength(1);
  });

  it('another booth cannot overwrite, adopt or attach rows', async () => {
    const r = (await c.call('POST', '/api/sync/push', { rows: [
      { tbl: 'orders', row: { ...order, boothId: c.bj.boothId, totalXof: 1, status: 'paid' } },                 // steal the order id
      { tbl: 'order_items', row: { id: 'h-oi-evil', orderId: 'h-ord-1', kind: 'digital', photoId: 'h-ph-1', qty: 1, unitPriceXof: 0, lineTotalXof: 0, createdAt: 1, updatedAt: 1 } },
      { tbl: 'photos', row: { id: 'h-ph-1', sessionId: 's', bookingId: 'h-bk-1', seq: 1, originalName: 'a', fileName: 'a', sha256: 'x', ingestStatus: 'ready', hidden: true, createdAt: 1, updatedAt: 2 } },
      { tbl: 'payments', row: { id: 'h-pay-evil', orderId: 'h-ord-1', method: 'cash', idempotencyKey: 'h-pay-evil', amountXof: 5_000, status: 'succeeded', createdAt: 1, updatedAt: 1 } },
      { tbl: 'customers', row: { id: 'h-cu-1', phone: '+221770000101', fullName: 'Renamed', createdAt: 1, updatedAt: 2 } },
    ] }, bj())).json;
    expect(r).toEqual({ accepted: 0, refused: [0, 1, 2, 3, 4] });
    const [o] = await c.db.query('select booth_id, total_xof, status from orders where id = $1', ['h-ord-1']);
    expect(o).toEqual({ booth_id: c.sn.boothId, total_xof: 5_000, status: 'open' });
    expect((await c.db.query('select hidden from photos where id = $1', ['h-ph-1']))[0]!.hidden).toBe(false);
    expect((await c.db.query('select full_name from customers where id = $1', ['h-cu-1']))[0]!.full_name).toBe('Un');
  });

  it('a booth cannot void or rewrite an online order', async () => {
    const b = (await book(0, '77 000 01 01')).json;
    const [o] = await c.db.query<{ id: string; booking_id: string }>(
      'select o.id, o.booking_id from orders o join bookings b on b.id = o.booking_id where b.public_token = $1', [b.token]);
    const base = { id: o!.id, bookingId: o!.booking_id, boothId: c.sn.boothId, status: 'void', subtotalXof: 0, totalXof: 0, vatBp: 1800, vatXof: 0, createdAt: 1, updatedAt: 9 };
    const r = (await c.call('POST', '/api/sync/push', { rows: [
      { tbl: 'orders', row: { ...base, channel: 'online' } },
      { tbl: 'orders', row: { ...base, channel: 'booth' } }, // lying about the channel does not help
    ] }, sn())).json;
    expect(r.refused).toEqual([0, 1]);
    expect((await c.db.query('select status, total_xof, channel from orders where id = $1', [o!.id]))[0]).toEqual({ status: 'open', total_xof: 5_000, channel: 'online' });
  });
});

describe('payments: never charge twice', () => {
  it('a second attempt first asks the provider about the first one', async () => {
    const order = { id: 'h-ord-2', bookingId: 'h-bk-1', boothId: c.sn.boothId, channel: 'booth', status: 'open', subtotalXof: 7_500, totalXof: 7_500, vatBp: 1800, vatXof: 1144, createdAt: 1, updatedAt: 1 };
    c.cinet.state.next = { status: 'pending', raw: {} };
    expect((await c.call('POST', '/api/sync/payments', { order, items: [], paymentId: 'h-pay-1', method: 'wave' }, sn())).status).toBe(200);
    // Same payment id sent again (network retry): refused cleanly, not a 500.
    expect((await c.call('POST', '/api/sync/payments', { order, items: [], paymentId: 'h-pay-1', method: 'wave' }, sn())).json.error).toBe('payment_exists');

    // The customer did pay the first link; the cashier, not knowing, starts another payment.
    c.cinet.state.next = { status: 'succeeded', amountXof: 7_500, operatorRef: 'W-1', raw: {} };
    const again = await c.call('POST', '/api/sync/payments', { order, items: [], paymentId: 'h-pay-2', method: 'orange_money' }, sn());
    expect([again.status, again.json.error]).toEqual([409, 'order_paid']);
    expect(await c.db.query(`select id from payments where order_id = 'h-ord-2' order by id`)).toHaveLength(1);
  });

  it('a provider outage is reported as provider_error, and leaves the payment pending', async () => {
    const order = { id: 'h-ord-3', bookingId: 'h-bk-1', boothId: c.sn.boothId, channel: 'booth', status: 'open', subtotalXof: 5_000, totalXof: 5_000, vatBp: 1800, vatXof: 763, createdAt: 1, updatedAt: 1 };
    c.cinet.state.next = { status: 'pending', raw: {} };
    await c.call('POST', '/api/sync/payments', { order, items: [], paymentId: 'h-pay-3', method: 'wave' }, sn());
    const check = c.cinet.p.check;
    c.cinet.p.check = async () => { throw new Error('ECONNRESET'); };
    try {
      const v = await c.call('POST', '/api/sync/payments/h-pay-3/verify', {}, sn());
      expect([v.status, v.json.error]).toEqual([502, 'provider_error']);
    } finally {
      c.cinet.p.check = check;
    }
    expect((await c.db.query(`select status from payments where id = 'h-pay-3'`))[0]!.status).toBe('pending');
  });
});

describe('public API abuse and races', () => {
  it('limits unpaid holds per phone and rejects malformed JSON with 400', async () => {
    expect((await book(1, '77 000 02 02')).status).toBe(201);
    expect((await book(2, '77 000 02 02')).status).toBe(201);
    const third = await book(3, '77 000 02 02');
    expect([third.status, third.json.error]).toEqual([429, 'too_many_pending']);
    const bad = await c.app.fetch(new Request('http://cloud.test/api/bookings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('invalid_json');
  });

  it('an expired hold cannot be re-taken once the place is gone; paying restarts the hold', async () => {
    const a = (await book(4, '77 000 03 03')).json;
    await c.db.query('update bookings set hold_expires_at = 1 where public_token = $1', [a.token]);
    const b = (await book(4, '77 000 04 04')).json; // the place went to another family
    expect(b.token).toBeTruthy();
    expect((await c.call('POST', `/api/bookings/${a.token}/pay`, { method: 'wave' })).json.error).toBe('slot_full');

    await c.db.query('update bookings set hold_expires_at = $2 where public_token = $1', [b.token, Date.now() + 60_000]); // 1 minute left
    c.cinet.state.next = { status: 'pending', raw: {} };
    expect((await c.call('POST', `/api/bookings/${b.token}/pay`, { method: 'wave' })).status).toBe(200);
    const [row] = await c.db.query<{ hold_expires_at: number }>('select hold_expires_at from bookings where public_token = $1', [b.token]);
    expect(row!.hold_expires_at).toBeGreaterThan(Date.now() + 14 * 60_000);
  });

  it('parallel PIN guesses cannot exceed the limit', async () => {
    const bk = (await book(5, '77 000 05 05')).json;
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      c.call('POST', `/api/gallery/${bk.token}/login`, { pin: String(100000 + i) })));
    const checked = results.filter((r) => r.status === 401).length; // PIN actually compared
    expect(checked).toBeLessThanOrEqual(5);
    expect(results.every((r) => r.status === 401 || r.status === 429)).toBe(true);
    expect((await c.call('POST', `/api/gallery/${bk.token}/login`, { pin: bk.pin })).status).toBe(429); // still locked
  });

  it('closed events cannot be booked by slot id', async () => {
    await c.db.query(`update events set status = 'closed' where id = $1`, [c.bj.eventId]);
    const [slot] = await c.db.query<{ id: string }>('select id from time_slots where booth_id = $1 limit 1', [c.bj.boothId]);
    const r = await c.call('POST', '/api/bookings', { slotId: slot!.id, packageCode: 'numerique', fullName: 'Famille Test', phone: '01 97 00 00 01', phoneCountry: 'BJ' });
    expect([r.status, r.json.error]).toEqual([404, 'slot_not_found']);
  });
});
