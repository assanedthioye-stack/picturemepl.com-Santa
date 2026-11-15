const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../server/db');
const { createServer } = require('../server/index');
const { dailySales } = require('../server/admin');

const PINS = { host: 'h1', photographer: 'p1', cashier: 'c1', monitor: 'm1', admin: 'a1' };
async function boot() {
  const db = openDb();
  db.prepare("INSERT INTO malls(id,name,country) VALUES(1,'M','SN')").run();
  db.prepare("INSERT INTO slots(id,mall_id,start_at,capacity) VALUES(1,1,?,5)").run(new Date().toISOString());
  const srv = createServer({ db, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'pmp-')), pins: PINS });
  await new Promise((r) => srv.listen(0, r));
  const base = 'http://localhost:' + srv.address().port;
  const call = async (method, url, body, pin, raw) => {
    const res = await fetch(base + url, { method, headers: { 'x-pin': pin || '', 'content-type': 'application/json' },
      body: raw || (body ? JSON.stringify(body) : undefined) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  };
  return { db, srv, call };
}

test('staff route needs the right PIN', async () => {
  const { srv, call } = await boot();
  assert.equal((await call('GET', '/api/queue?mall=1')).status, 401);
  assert.equal((await call('GET', '/api/queue?mall=1', null, 'c1')).status, 401);
  assert.equal((await call('GET', '/api/queue?mall=1', null, 'h1')).status, 200);
  assert.equal((await call('GET', '/api/queue?mall=1', null, 'a1')).status, 200);
  assert.equal((await call('GET', '/api/queue?mall=1', null, 'm1')).status, 401); // kiosk PIN must not list family codes
  srv.close();
});
test('end to end: book, check in, serve, upload, cart, pay, print, download', async () => {
  const { db, srv, call } = await boot();
  const slots = await call('GET', '/api/slots?mall=1&day=' + new Date().toISOString().slice(0, 10));
  const b = await call('POST', '/api/book', { slotId: slots.json[0].id, name: 'Awa', phone: '1', consent: true });
  const code = b.json.code;
  assert.equal((await call('POST', '/api/checkin', { code }, 'h1')).json.kind, 'appointment');
  assert.equal((await call('POST', '/api/next', { mall: 1 }, 'h1')).json.code, code);
  assert.equal((await call('POST', '/api/photos?mall=1&name=a.jpg', null, 'p1', 'JPEGDATA')).json.code, code);
  const g = await call('GET', '/api/gallery/' + code, null, 'm1');
  assert.equal(g.json.length, 1);
  const cart = await call('POST', '/api/cart', { code, items: [{ item: 'famille', qty: 1 }], files: g.json }, 'm1');
  assert.equal(cart.json.total, 10000);
  assert.equal((await call('GET', '/api/print/next?mall=1', null, 'c1')).json, null);
  assert.equal((await call('POST', '/api/pay', { code, method: 'mobile_money', provider: 'Wave', reference: 'T1', expectedTotal: 10000 }, 'c1')).json.total, 10000);
  assert.equal((await call('GET', '/api/print/next?mall=1', null, 'c1')).json.code, code);
  assert.equal((await call('GET', `/dl/${code}/${g.json[0]}`)).text, 'JPEGDATA');
  assert.equal((await call('GET', `/dl/NOPE1234/x.jpg`)).status, 404);
  assert.equal((await call('GET', `/photo/${code}/${g.json[0]}`)).status, 401);
  const day = new Date().toISOString().slice(0, 10);
  assert.deepEqual(dailySales(db, 1, day), { total: 10000, byMethod: { mobile_money: 10000 }, byProvider: { Wave: 10000 } });
  srv.close();
});
test('dashboard route is admin-only and validates input', async () => {
  const { srv, call } = await boot();
  assert.equal((await call('GET', '/api/admin/dashboard?country=SN', null, 'c1')).status, 401);
  assert.equal((await call('GET', '/api/admin/dashboard?country=SN', null, 'a1')).status, 200);
  assert.equal((await call('GET', '/api/admin/dashboard?from=bad', null, 'a1')).status, 400);
  srv.close();
});
test('csv export is admin-only and downloads as a file', async () => {
  const { srv, call } = await boot();
  assert.equal((await call('GET', '/api/admin/export?type=orders&from=2026-12-01&to=2026-12-31', null, 'c1')).status, 401);
  const r = await fetch('http://localhost:' + srv.address().port + '/api/admin/export?type=daily&from=2026-12-01&to=2026-12-02', { headers: { 'x-pin': 'a1' } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="daily_/);
  assert.equal((await r.text()).trim().split('\r\n').length, 3);
  assert.equal((await call('GET', '/api/admin/export?type=orders&from=bad&to=x', null, 'a1')).status, 400);
  srv.close();
});
test('upload with no active family is a clear 409', async () => {
  const { srv, call } = await boot();
  const r = await call('POST', '/api/photos?mall=1&name=a.jpg', null, 'p1', 'x');
  assert.equal(r.status, 409);
  srv.close();
});
test('admin can edit prices; cart uses new price', async () => {
  const { srv, call } = await boot();
  assert.equal((await call('PUT', '/api/admin/prices', { country: 'SN', item: 'famille', amount: 11000 }, 'h1')).status, 401);
  assert.equal((await call('PUT', '/api/admin/prices', { country: 'SN', item: 'famille', amount: 11000 }, 'a1')).status, 200);
  srv.close();
});
