const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const sharp = require('sharp');
const { openDb } = require('../server/db');
const jpeg = () => sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#808080' } }).jpeg().toBuffer();
const { createServer } = require('../server/app');
const { listSlots, book, cancel } = require('../server/booking');
const { checkIn, addWalkIn, serveNext } = require('../server/queue');
const { saveCart, pay } = require('../server/orders');
const { addMall, addSlots, dailySales } = require('../server/admin');

const PINS = { host: 'h111', photographer: 'p111', cashier: 'c111', monitor: 'm111', admin: 'a111' };
const P = { name: 'Awa', phone: '+221700000000', consent: true };
function db2() {
  const db = openDb();
  db.prepare("INSERT INTO malls(id,name,country) VALUES(1,'Dakar','SN'),(2,'Cotonou','BJ')").run();
  return db;
}
async function boot(db = db2()) {
  const errors = [];
  const srv = createServer({ db, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'pmp-')), pins: PINS, log: (...a) => errors.push(a) });
  await new Promise((r) => srv.listen(0, r));
  const base = 'http://localhost:' + srv.address().port;
  const call = async (method, url, body, pin, raw) => {
    const res = await fetch(base + url, { method, headers: { 'x-pin': pin || '' }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  return { db, srv, call, errors, port: srv.address().port };
}

test('a malformed request URL gets an error answer and the server keeps running', async () => {
  const { srv, call, port } = await boot();
  const reply = await new Promise((resolve) => {
    const s = net.connect(port, 'localhost', () => s.write('GET //%%/ HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n'));
    let out = ''; s.on('data', (d) => (out += d)); s.on('close', () => resolve(out)); s.on('error', () => resolve(out));
  });
  assert.match(reply, /^HTTP\/1\.1 [45]\d\d/);
  assert.equal((await call('GET', '/api/malls')).status, 200);
  srv.close();
});
test('a PIN in the URL is not accepted (header only)', async () => {
  const { srv, call } = await boot();
  assert.equal((await call('GET', '/api/queue?mall=1&pin=h111')).status, 401);
  assert.equal((await call('GET', '/api/queue?mall=1', null, 'h111')).status, 200);
  srv.close();
});
test('PIN guessing is locked out after 20 wrong tries, even with the right PIN afterwards', async () => {
  const { srv, call } = await boot();
  for (let i = 0; i < 20; i++) assert.equal((await call('GET', '/api/queue?mall=1', null, 'x' + i)).status, 401);
  assert.equal((await call('GET', '/api/queue?mall=1', null, 'x')).status, 429);
  assert.equal((await call('GET', '/api/queue?mall=1', null, 'h111')).status, 429);
  assert.equal((await call('GET', '/api/malls')).status, 200); // public pages still work
  srv.close();
});
test('unexpected errors answer 500 without leaking details, and are logged', async () => {
  const { db, srv, call, errors } = await boot();
  db.exec('DROP TABLE prices');
  const r = await call('GET', '/api/prices');
  assert.equal(r.status, 500);
  assert.deepEqual(r.json, { error: 'server error' });
  assert.equal(errors.length, 1);
  srv.close();
});
test('bad JSON, non-object JSON and oversized bodies are refused cleanly', async () => {
  const { srv, call } = await boot();
  assert.equal((await call('POST', '/api/book', null, '', '{nope')).json.error, 'bad json');
  assert.equal((await call('POST', '/api/book', null, '', 'null')).json.error, 'bad json');
  assert.equal((await call('POST', '/api/book', null, '', JSON.stringify({ name: 'x'.repeat(200000) }))).status, 413);
  srv.close();
});
test('security headers are set and unknown file types are not served', async () => {
  const { srv, call } = await boot();
  const r = await call('GET', '/book.html');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal((await call('GET', '/../package.json')).status, 404);
  srv.close();
});
test('only images can be uploaded, and only recorded photos are served', async () => {
  const { db, srv, call } = await boot();
  const code = addWalkIn(db, 1, P).code;
  serveNext(db, 1);
  assert.equal((await call('POST', '/api/photos?mall=1&name=evil.html', null, 'p111', '<script>1</script>')).json.error, 'bad file');
  assert.equal((await call('POST', '/api/photos?mall=1&name=a.jpg', null, 'p111', '')).json.error, 'bad file');
  const up = await call('POST', '/api/photos?mall=1&name=a.jpg', null, 'p111', await jpeg());
  assert.equal((await call('GET', `/preview/${code}/${up.json.file}`, null, 'm111')).status, 200);
  assert.equal((await call('GET', `/preview/${code}/nope.jpg`, null, 'm111')).status, 404);
  assert.equal((await call('GET', `/preview/${code}/${up.json.file}`)).status, 401);
  assert.equal((await call('POST', '/api/photos?mall=99&name=a.jpg', null, 'p111', await jpeg())).json.error, 'unknown mall');
  srv.close();
});
test('past slots are hidden and cannot be booked; the grace period still counts', () => {
  const db = db2();
  const now = new Date('2026-12-20T12:00:00Z');
  db.prepare("INSERT INTO slots(id,mall_id,start_at,capacity) VALUES(1,1,'2026-12-20T10:00:00.000Z',5),(2,1,'2026-12-20T11:45:00.000Z',5),(3,1,'2026-12-20T15:00:00.000Z',5)").run();
  assert.deepEqual(listSlots(db, 1, '2026-12-20', now).map((s) => s.id), [2, 3]);
  assert.throws(() => book(db, { ...P, slotId: 1 }, now), /past/);
  assert.ok(book(db, { ...P, slotId: 2 }, now).code);
});
test('slots are listed by the mall local day and show local time (Benin is UTC+1)', () => {
  const db = db2();
  addSlots(db, { mall: 2, fromDay: '2026-12-20', toDay: '2026-12-20', open: '00:00', close: '01:00', minutes: 30, capacity: 2 });
  const now = new Date('2026-12-01T00:00:00Z');
  assert.deepEqual(listSlots(db, 2, '2026-12-20', now).map((s) => s.local_time), ['00:00', '00:30']); // stored as 23:00 UTC the day before
  assert.equal(listSlots(db, 2, '2026-12-19', now).length, 0);
  assert.throws(() => listSlots(db, 2, "2026-12-20' --", now), /bad day/);
  assert.throws(() => listSlots(db, 99, '2026-12-20', now), /unknown mall/);
});
test('booking input is validated', () => {
  const db = db2();
  db.prepare("INSERT INTO slots(id,mall_id,start_at,capacity) VALUES(1,1,'2030-01-01T10:00:00.000Z',5)").run();
  for (const bad of [{ name: '' }, { name: 'x'.repeat(81) }, { name: { a: 1 } }, { phone: 'abc' }, { phone: '12' }]) assert.throws(() => book(db, { ...P, slotId: 1, ...bad }), /name and phone required/);
  assert.throws(() => book(db, { ...P, slotId: 1, consent: 'yes' }), /consent/);
  assert.throws(() => book(db, { ...P, slotId: '1; DROP' }), /unknown slot/);
});
test('cancelling an unknown or already-used code is reported, not silently accepted', () => {
  const db = db2();
  db.prepare("INSERT INTO slots(id,mall_id,start_at,capacity) VALUES(1,1,'2030-01-01T10:00:00.000Z',5)").run();
  assert.throws(() => cancel(db, 'NOPE2345'), /unknown code/);
  const { code } = book(db, { ...P, slotId: 1 });
  cancel(db, code);
  assert.throws(() => cancel(db, code), /unknown code/);
});
test('a code booked at another mall is refused at check-in', () => {
  const db = db2();
  db.prepare("INSERT INTO slots(id,mall_id,start_at,capacity) VALUES(1,1,'2030-01-01T10:00:00.000Z',5)").run();
  const { code } = book(db, { ...P, slotId: 1 });
  assert.throws(() => checkIn(db, code, new Date('2030-01-01T10:00:00Z'), 2), /wrong mall/);
  assert.equal(checkIn(db, code, new Date('2030-01-01T10:00:00Z'), 1).kind, 'appointment');
  assert.throws(() => checkIn(db, code, new Date('2030-01-01T10:01:00Z'), 2), /wrong mall/);
});
test('an order cannot be paid without a photo, a cashier name or a whole-number cash amount', () => {
  const db = db2();
  const code = addWalkIn(db, 1, P).code;
  serveNext(db, 1);
  db.prepare("INSERT INTO photos(code,file) VALUES(?,'p.jpg')").run(code);
  saveCart(db, code, [{ item: 'famille', qty: 1 }], []);
  const ok = { method: 'cash', amountReceived: 10000, expectedTotal: 10000, cashier: 'amy' };
  assert.throws(() => pay(db, code, ok), /no photos/);
  saveCart(db, code, [{ item: 'famille', qty: 1 }], ['p.jpg']);
  assert.throws(() => pay(db, code, { ...ok, cashier: '' }), /invalid payment/);
  assert.throws(() => pay(db, code, { ...ok, amountReceived: '10000' }), /invalid payment/);
  assert.throws(() => pay(db, code, { ...ok, amountReceived: 10000.5 }), /invalid payment/);
  assert.equal(pay(db, code, ok).total, 10000);
  assert.throws(() => pay(db, code, ok), /already paid/);
});
test('cart input is validated', () => {
  const db = db2();
  const code = addWalkIn(db, 1, P).code;
  for (const bad of [null, 'x', [null], [{ item: 'famille', qty: 21 }], [{ item: 'famille', qty: 1.5 }], [{ item: 5, qty: 1 }]]) assert.throws(() => saveCart(db, code, bad, []), /bad item/);
  assert.throws(() => saveCart(db, 'NOPE2345', [{ item: 'famille', qty: 1 }], []), /unknown code/);
});
test('duplicate malls are refused; daily sales use the mall local day', () => {
  const db = db2();
  assert.throws(() => addMall(db, 'dakar', 'SN'), /bad mall/);
  addMall(db, 'Dakar', 'CI'); // same name in another country is fine
  const code = addWalkIn(db, 2, P).code;
  serveNext(db, 2);
  db.prepare("INSERT INTO photos(code,file) VALUES(?,'p.jpg')").run(code);
  saveCart(db, code, [{ item: 'famille', qty: 1 }], ['p.jpg']);
  pay(db, code, { method: 'cash', amountReceived: 8500, expectedTotal: 8500, cashier: 'amy' }, new Date('2026-12-20T23:30:00Z')); // 00:30 on the 21st in Benin
  assert.equal(dailySales(db, 2, '2026-12-21').total, 8500);
  assert.equal(dailySales(db, 2, '2026-12-20').total, 0);
});
test('staff routes reject an unknown mall instead of acting on nothing', async () => {
  const { srv, call } = await boot();
  assert.equal((await call('GET', '/api/queue?mall=99', null, 'h111')).status, 404);
  assert.equal((await call('POST', '/api/walkin', { ...P, mall: 99 }, 'h111')).status, 404);
  assert.equal((await call('POST', '/api/next', { mall: 'abc' }, 'h111')).status, 404);
  assert.equal((await call('POST', '/api/cancel', { code: 'NOPE2345' })).status, 404);
  srv.close();
});
test('a database created by the first deployed version opens and upgrades in place', () => {
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pmp-')), 'app.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE malls(id INTEGER PRIMARY KEY, name TEXT, country TEXT);
    CREATE TABLE queue(id INTEGER PRIMARY KEY, mall_id INTEGER, booking_id INTEGER, code TEXT UNIQUE, name TEXT, phone TEXT, kind TEXT, sort_at TEXT, checked_in_at TEXT, state TEXT DEFAULT 'waiting');
    INSERT INTO malls(name,country) VALUES('Francoise Garden','SN');`);
  old.close();
  const db = openDb(file);
  assert.equal(db.prepare('SELECT name FROM malls').get().name, 'Francoise Garden');
  const code = addWalkIn(db, 1, P).code;
  assert.equal(serveNext(db, 1).code, code); // needs the served_at column added by the upgrade
  db.close();
  openDb(file).close(); // and opening twice is harmless
});
