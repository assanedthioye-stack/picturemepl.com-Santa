import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeCloud } from './harness';

let c: Awaited<ReturnType<typeof makeCloud>>;
beforeAll(async () => { c = await makeCloud(); });
afterAll(async () => { await c.close(); });

const family = (slotId: string, extra: object = {}) => ({ slotId, packageCode: 'famille', fullName: 'Famille Diop', phone: '77 123 45 67', phoneCountry: 'SN', partySize: 4, ...extra });

describe('public booking', () => {
  let token = '';
  let pin = '';
  let slots: Array<{ id: string; startsAt: number; available: number }> = [];

  it('lists malls, slots in local time, and the country price list', async () => {
    const venues = (await c.call('GET', '/api/venues?country=SN')).json;
    expect(venues).toHaveLength(1);
    expect(venues[0]).toMatchObject({ name: 'Centre Démo', city: 'Dakar', eventId: c.sn.eventId });
    slots = (await c.call('GET', `/api/slots?eventId=${c.sn.eventId}&date=${c.today}`)).json;
    expect(slots).toHaveLength(8); // 10:00–12:00 every 15 min
    expect(new Date(slots[0]!.startsAt).toISOString().slice(11, 16)).toBe('10:00'); // Dakar = UTC
    const bjSlots = (await c.call('GET', `/api/slots?eventId=${c.bj.eventId}&date=${c.today}`)).json;
    expect(new Date(bjSlots[0].startsAt).toISOString().slice(11, 16)).toBe('09:00'); // Cotonou 10:00 = 09:00 UTC
    const pkgs = (await c.call('GET', '/api/packages?country=CI')).json;
    expect(pkgs.map((p: any) => [p.code, p.priceXof])).toEqual([['essentiel', 9_000], ['famille', 12_000], ['prestige', 21_500], ['numerique', 6_000]]);
  });

  it('holds the slot for 15 minutes and refuses a second family', async () => {
    const r = await c.call('POST', '/api/bookings', family(slots[0]!.id));
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ amountXof: 10_000 });
    expect(r.json.code).toMatch(/^[1-8]\d{5}$/);
    expect(r.json.pin).toMatch(/^\d{6}$/);
    ({ token, pin } = r.json);
    expect((await c.call('POST', '/api/bookings', family(slots[0]!.id, { fullName: 'Famille Ba' }))).json.error).toBe('slot_full');
    expect((await c.call('GET', `/api/slots?eventId=${c.sn.eventId}&date=${c.today}`)).json[0].available).toBe(0);
    expect((await c.call('POST', '/api/bookings', family(slots[1]!.id, { phone: '77 12' }))).status).toBe(400);
    const page = (await c.call('GET', `/api/bookings/${token}`)).json;
    expect(page).toMatchObject({ status: 'pending_payment', code: null, familyName: 'Famille Diop', amountXof: 10_000 });
  });

  it('only offers the country\'s Mobile Money methods', async () => {
    expect((await c.call('POST', `/api/bookings/${token}/pay`, { method: 'mtn_momo', phone: '77 123 45 67' })).json.error).toBe('method_not_offered');
  });

  it('pays through the provider; the webhook is only a hint, the provider check confirms', async () => {
    const pay = await c.call('POST', `/api/bookings/${token}/pay`, { method: 'wave' });
    expect(pay.json).toMatchObject({ kind: 'redirect' });
    expect(c.cinet.inits.at(-1)).toMatchObject({ amountXof: 10_000, method: 'wave', country: 'SN', phone: '+221771234567', returnUrl: `https://web.test/b/${token}?paid=1`, notifyUrl: 'http://cloud.test/api/webhooks/cinetpay' });

    // A webhook while the provider still says pending changes nothing.
    await c.call('POST', '/api/webhooks/cinetpay', { cpm_trans_id: pay.json.paymentId });
    expect((await c.call('GET', `/api/bookings/${token}`)).json.status).toBe('pending_payment');

    // Amount mismatch is never accepted.
    c.cinet.state.next = { status: 'succeeded', amountXof: 100, raw: {} };
    await c.call('POST', '/api/webhooks/cinetpay', { cpm_trans_id: pay.json.paymentId });
    expect((await c.call('GET', `/api/bookings/${token}`)).json.status).toBe('pending_payment');

    c.cinet.state.next = { status: 'succeeded', amountXof: 10_000, operatorRef: 'WAVE-1', raw: {} };
    const form = new URLSearchParams({ cpm_trans_id: pay.json.paymentId, cpm_site_id: '1' });
    const res = await c.app.fetch(new Request('http://cloud.test/api/webhooks/cinetpay', { method: 'POST', body: form }));
    expect(res.status).toBe(200);
    const page = (await c.call('GET', `/api/bookings/${token}`)).json;
    expect(page).toMatchObject({ status: 'confirmed', paymentStatus: 'succeeded' });
    expect(page.code).toMatch(/^[1-8]\d{5}$/);
    expect((await c.call('POST', `/api/bookings/${token}/pay`, { method: 'wave' })).json.error).toBe('booking_confirmed');
  });

  it('Benin: MTN push to the payer\'s phone; Celtiis is not integrated', async () => {
    const bjSlot = (await c.call('GET', `/api/slots?eventId=${c.bj.eventId}&date=${c.today}`)).json[0];
    const b = (await c.call('POST', '/api/bookings', family(bjSlot.id, { phone: '01 97 12 34 56', phoneCountry: 'BJ', packageCode: 'numerique' }))).json;
    expect(b.amountXof).toBe(4_500);
    expect((await c.call('POST', `/api/bookings/${b.token}/pay`, { method: 'celtiis_cash' })).json.error).toBe('method_not_integrated');
    const pay = (await c.call('POST', `/api/bookings/${b.token}/pay`, { method: 'mtn_momo' })).json;
    expect(pay.kind).toBe('push');
    expect(c.mtn.inits.at(-1)).toMatchObject({ phone: '+2290197123456', amountXof: 4_500 });
    c.mtn.state.next = { status: 'failed', raw: {} };
    await c.call('PUT', '/api/webhooks/mtn', { externalId: pay.paymentId, status: 'FAILED' });
    expect((await c.call('GET', `/api/bookings/${b.token}`)).json).toMatchObject({ status: 'pending_payment', paymentStatus: 'failed' });
  });

  it('gallery: wrong PIN locks after 5 tries', async () => {
    const other = (await c.call('POST', '/api/bookings', family((await c.call('GET', `/api/slots?eventId=${c.sn.eventId}&date=${c.today}`)).json[3].id))).json;
    for (let i = 0; i < 5; i++) expect((await c.call('POST', `/api/gallery/${other.token}/login`, { pin: '000000' })).status).toBe(401);
    expect((await c.call('POST', `/api/gallery/${other.token}/login`, { pin: other.pin })).json.error).toBe('too_many_attempts');
    expect((await c.call('GET', `/api/gallery/${token}/photos`)).status).toBe(401);
    expect((await c.call('POST', `/api/gallery/${token}/login`, { pin })).json.session).toBeTruthy();
  });
});

describe('booth sync', () => {
  const walkIn = (boothId: string, id = 'bk-walkin-1') => ({
    id, code: '912345', publicToken: 'walkin-token-1', pinHash: 'h', eventId: 'e', boothId, customerId: 'cu-1',
    source: 'walk_in', status: 'checked_in', partySize: 2, createdAt: 1, updatedAt: 1,
  });

  it('authenticates booths and scopes their rows', async () => {
    expect((await c.call('GET', '/api/sync/me')).status).toBe(401);
    const me = (await c.call('GET', '/api/sync/me', undefined, c.booth(c.sn.token))).json;
    expect(me).toMatchObject({ id: c.sn.boothId, country: 'SN', merchant: { mtn_momo: '2290159089346' } });
    const r = (await c.call('POST', '/api/sync/push', { rows: [
      { tbl: 'customers', row: { id: 'cu-1', phone: '+221770000001', fullName: 'Walk In', createdAt: 1, updatedAt: 1 } },
      { tbl: 'bookings', row: walkIn(c.sn.boothId) },
      { tbl: 'bookings', row: walkIn(c.bj.boothId, 'bk-other-booth') },           // another booth's row
      { tbl: 'payments', row: { id: 'p-forged', orderId: 'o', method: 'wave', provider: 'cinetpay', idempotencyKey: 'x', amountXof: 1, status: 'succeeded', createdAt: 1, updatedAt: 1 } },
      { tbl: 'users', row: { id: 'u1' } },                                          // not synced
    ] }, c.booth(c.sn.token))).json;
    expect(r).toEqual({ accepted: 2, refused: [2, 3, 4] });
  });

  it('only moves statuses forward and never lets a booth edit cloud fields', async () => {
    await c.call('POST', '/api/sync/push', { rows: [{ tbl: 'bookings', row: { ...walkIn(c.sn.boothId), status: 'confirmed', code: '111111', updatedAt: 2 } }] }, c.booth(c.sn.token));
    const [b] = await c.db.query('select status, code from bookings where id = $1', ['bk-walkin-1']);
    expect(b).toEqual({ status: 'checked_in', code: '912345' }); // status kept; code is insert-only
  });

  it('pulls the online bookings of its own booth only', async () => {
    const pull = (await c.call('GET', '/api/sync/pull?since=0', undefined, c.booth(c.sn.token))).json;
    const online = pull.rows.bookings.filter((b: any) => b.source === 'online');
    expect(online.length).toBeGreaterThanOrEqual(2);
    expect(online.every((b: any) => b.booth_id === c.sn.boothId)).toBe(true);
    expect(pull.rows.orders.some((o: any) => o.channel === 'online' && o.status === 'paid')).toBe(true);
    expect(pull.rows.customers.length).toBeGreaterThan(0);
    expect(pull.cursor).toBeGreaterThan(0);
    const again = (await c.call('GET', `/api/sync/pull?since=${pull.cursor}`, undefined, c.booth(c.sn.token))).json;
    expect(Object.values(again.rows).flat()).toHaveLength(0);
  });

  it('uploads through signed URLs; the gallery then sells and unlocks photos', async () => {
    const page = (await c.call('GET', '/api/sync/pull?since=0', undefined, c.booth(c.sn.token))).json;
    const confirmed = page.rows.bookings.find((b: any) => b.status === 'confirmed');
    const photo = (id: string, seq: number) => ({ tbl: 'photos', row: { id, sessionId: 's1', bookingId: confirmed.id, seq, originalName: `${seq}.jpg`, fileName: `${seq}.jpg`, sha256: id, ingestStatus: 'ready', hidden: false, favorite: false, createdAt: 1, updatedAt: 1, previewKey: 'forged' } });
    await c.call('POST', '/api/sync/push', { rows: [photo('ph-1', 1), photo('ph-2', 2)] }, c.booth(c.sn.token));
    expect((await c.db.query('select preview_key from photos where id = $1', ['ph-1']))[0]!.preview_key).toBeNull(); // cloud-only column

    for (const id of ['ph-1', 'ph-2']) {
      for (const kind of ['thumb', 'preview', 'deliverable']) {
        const u = (await c.call('POST', '/api/sync/upload-url', { photoId: id, kind }, c.booth(c.sn.token))).json;
        const put = await c.app.fetch(new Request(u.url, { method: 'PUT', headers: u.headers, body: new TextEncoder().encode(`${id}-${kind}`) }));
        expect(put.status).toBe(200);
        await c.call('POST', '/api/sync/uploaded', { photoId: id, kind }, c.booth(c.sn.token));
      }
    }
    expect((await c.call('POST', '/api/sync/upload-url', { photoId: 'ph-1', kind: 'preview' }, c.booth(c.bj.token))).status).toBe(404); // not its photo

    const token = (await c.db.query<{ public_token: string }>('select public_token from bookings where id = $1', [confirmed.id]))[0]!.public_token;
    await c.db.query(`update bookings set pin_hash = (select pin_hash from bookings where public_token = $1) where id = $2`, [token, confirmed.id]);
    const pin = '123456';
    const { hashPin } = await import('../src/pin');
    await c.db.query('update bookings set pin_hash = $1 where id = $2', [await hashPin(pin), confirmed.id]);
    const session = (await c.call('POST', `/api/gallery/${token}/login`, { pin })).json.session;
    const auth = { Authorization: `Bearer ${session}` };
    let g = (await c.call('GET', `/api/gallery/${token}/photos`, undefined, auth)).json;
    expect(g.unitPriceXof).toBe(5_000);
    expect(g.photos.map((p: any) => [p.seq, p.unlocked, p.downloadUrl])).toEqual([[1, false, null], [2, false, null]]);
    const thumb = await c.app.fetch(new Request(g.photos[0].thumbUrl));
    expect(await thumb.text()).toBe('ph-1-thumb');

    const buy = (await c.call('POST', `/api/gallery/${token}/buy`, { photoIds: ['ph-2'], method: 'orange_money' }, auth)).json;
    expect(buy).toMatchObject({ kind: 'redirect', totalXof: 5_000 });
    c.cinet.state.next = { status: 'succeeded', amountXof: 5_000, raw: {} };
    await c.call('GET', `/api/bookings/${token}`); // the customer's polling re-checks the provider
    g = (await c.call('GET', `/api/gallery/${token}/photos`, undefined, auth)).json;
    expect(g.photos.map((p: any) => p.unlocked)).toEqual([false, true]);
    expect(await (await c.app.fetch(new Request(g.photos[1].downloadUrl))).text()).toBe('ph-2-deliverable');
    expect((await c.call('POST', `/api/gallery/${token}/buy`, { photoIds: ['ph-2'], method: 'wave' }, auth)).json.error).toBe('already_unlocked');
  });

  it('cashier Mobile Money: booth sends the order, polls, and can force a verify', async () => {
    const order = { id: 'ord-booth-1', bookingId: 'bk-walkin-1', boothId: c.sn.boothId, channel: 'booth', status: 'open', subtotalXof: 7_500, totalXof: 7_500, vatBp: 1800, vatXof: 1144, createdAt: 1, updatedAt: 1 };
    const items = [{ id: 'oi-1', orderId: 'ord-booth-1', packageId: 'pkg_essentiel_SN', kind: 'bundle', qty: 1, unitPriceXof: 7_500, lineTotalXof: 7_500, createdAt: 1, updatedAt: 1 }];
    c.cinet.state.next = { status: 'pending', raw: {} };
    const init = (await c.call('POST', '/api/sync/payments', { order, items, paymentId: 'pay-booth-1', method: 'wave', phone: '77 123 45 67' }, c.booth(c.sn.token))).json;
    expect(init).toMatchObject({ kind: 'redirect' });
    expect(c.cinet.inits.at(-1)).toMatchObject({ paymentId: 'pay-booth-1', amountXof: 7_500, returnUrl: 'https://web.test/merci' });
    expect((await c.call('GET', '/api/sync/payments/pay-booth-1', undefined, c.booth(c.sn.token))).json.status).toBe('pending');
    expect((await c.call('GET', '/api/sync/payments/pay-booth-1', undefined, c.booth(c.bj.token))).status).toBe(404);

    // Webhook never came: the cashier forces a check with the id from the customer's SMS.
    c.cinet.state.next = { status: 'succeeded', amountXof: 7_500, operatorRef: 'W-77', raw: {} };
    const v = (await c.call('POST', '/api/sync/payments/pay-booth-1/verify', { operatorRef: 'w-77' }, c.booth(c.sn.token))).json;
    expect(v).toEqual({ status: 'succeeded', operatorRef: 'W-77', operatorMismatch: false });
    expect((await c.db.query('select status from orders where id = $1', ['ord-booth-1']))[0]!.status).toBe('paid');
    // A booth push cannot downgrade the paid order or the provider payment.
    await c.call('POST', '/api/sync/push', { rows: [{ tbl: 'orders', row: { ...order, status: 'open', updatedAt: 9 } }] }, c.booth(c.sn.token));
    expect((await c.db.query('select status from orders where id = $1', ['ord-booth-1']))[0]!.status).toBe('paid');
  });
});
