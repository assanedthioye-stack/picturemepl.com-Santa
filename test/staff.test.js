const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { openDb } = require('../server/db');
const { createServer } = require('../server/app');
const staff = require('../server/staff');
const { dashboard } = require('../server/stats');

const S = 'secret';
const PINS = { host: 'h111', photographer: 'p111', cashier: 'c111', monitor: 'm111', admin: 'a111', printer: 'r111' };
const P = { name: 'Fam', phone: '+221700000000', consent: true };
async function boot() {
  const db = openDb();
  db.prepare("INSERT INTO malls(id,name,country) VALUES(1,'Dakar','SN')").run();
  const srv = createServer({ db, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'pmp-')), pins: PINS, secret: S });
  await new Promise((r) => srv.listen(0, r));
  const call = async (m, u, b, pin, raw) => {
    const r = await fetch('http://localhost:' + srv.address().port + u, { method: m, headers: { 'x-pin': pin || '' }, body: raw ?? (b ? JSON.stringify(b) : undefined) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  return { db, srv, call };
}

test('creating staff gives a unique 6-digit PIN, stored only as a keyed hash', () => {
  const db = openDb();
  const a = staff.create(db, S, { name: 'Fatou', role: 'host' });
  const b = staff.create(db, S, { name: 'Moussa', role: 'host' });
  assert.match(a.pin, /^\d{6}$/);
  assert.notEqual(a.pin, b.pin);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM staff').all()).includes(a.pin));
  assert.deepEqual(staff.find(db, S, a.pin), { id: a.id, name: 'Fatou', role: 'host' });
  assert.equal(staff.find(db, S, '000000'), null);
  assert.equal(staff.find(db, 'other-secret', a.pin), null);
  assert.deepEqual(staff.list(db).map((s) => [s.name, s.role, s.active]), [['Fatou', 'host', true], ['Moussa', 'host', true]]);
});
test('bad or duplicate staff are refused; a new PIN never collides with a device PIN', () => {
  const db = openDb();
  staff.create(db, S, { name: 'Fatou', role: 'host' });
  for (const bad of [{ name: '', role: 'host' }, { name: 'X', role: 'monitor' }, { name: 'fatou', role: 'host' }, { name: 'X'.repeat(41), role: 'host' }]) assert.throws(() => staff.create(db, S, bad), /bad staff/);
  staff.create(db, S, { name: 'Fatou', role: 'cashier' }); // same person, second role: fine
  assert.throws(() => staff.create(db, S, { name: 'Z', role: 'host', pin: 'm111' }, ['m111']), /bad staff/);
});
test('a deactivated PIN stops working at once; a reset replaces the PIN', () => {
  const db = openDb();
  const a = staff.create(db, S, { name: 'Fatou', role: 'host' });
  const { pin } = staff.resetPin(db, S, a.id);
  assert.equal(staff.find(db, S, a.pin), null);
  assert.equal(staff.find(db, S, pin).name, 'Fatou');
  staff.setActive(db, a.id, false);
  assert.equal(staff.find(db, S, pin), null);
  assert.throws(() => staff.resetPin(db, S, 999), /unknown staff/);
});
test('shared role PINs no longer open staff screens; personal PINs do, for their own role only', async () => {
  const { db, srv, call } = await boot();
  assert.equal((await call('GET', '/api/queue?mall=1', null, 'h111')).status, 401); // old shared host PIN
  assert.equal((await call('POST', '/api/pay', { code: 'X' }, 'c111')).status, 401); // old shared cashier PIN
  const host = staff.create(db, S, { name: 'Fatou', role: 'host' }, Object.values(PINS));
  assert.equal((await call('GET', '/api/queue?mall=1', null, host.pin)).status, 200);
  assert.equal((await call('POST', '/api/pay', { code: 'X' }, host.pin)).status, 401); // a host is not a cashier
  assert.deepEqual((await call('GET', '/api/me', null, host.pin)).json, { name: 'Fatou', role: 'host' });
  assert.deepEqual((await call('GET', '/api/me', null, 'a111')).json, { name: 'Admin', role: 'admin' });
  assert.equal((await call('GET', '/api/active?mall=1', null, 'm111')).status, 200); // device PINs still work
  srv.close();
});
test('actions are credited to the PIN owner, whatever name the browser sends', async () => {
  const { db, srv, call } = await boot();
  const all = Object.values(PINS);
  const host = staff.create(db, S, { name: 'Fatou', role: 'host' }, all), shooter = staff.create(db, S, { name: 'Awa', role: 'photographer' }, all), till = staff.create(db, S, { name: 'Amy', role: 'cashier' }, all);
  const code = (await call('POST', '/api/walkin', { ...P, mall: 1, staff: 'Someone Else' }, host.pin)).json.code;
  await call('POST', '/api/next', { mall: 1, staff: 'Someone Else' }, host.pin);
  const img = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#808080' } }).jpeg().toBuffer();
  const up = await call('POST', '/api/photos?mall=1&name=a.jpg', null, shooter.pin, img);
  await call('POST', '/api/cart', { code, items: [{ item: 'famille', qty: 1 }], files: [up.json.file] }, till.pin);
  assert.equal((await call('POST', '/api/pay', { code, method: 'cash', amountReceived: 10000, expectedTotal: 10000, cashier: 'Someone Else' }, till.pin)).status, 200);
  const today = new Date().toISOString().slice(0, 10);
  const t = dashboard(db, { from: today, to: today, country: 'SN' }).team;
  assert.deepEqual(t.hosts.map((h) => h.name), ['Fatou']);
  assert.deepEqual(t.photographers.map((h) => h.name), ['Awa']);
  assert.deepEqual(t.cashiers.map((h) => h.name), ['Amy']);
  await call('GET', '/api/active?mall=1', null, shooter.pin);
  assert.deepEqual(dashboard(db, { from: today, to: today, country: 'SN' }).team.onDuty.map((x) => `${x.role}:${x.name}`), ['host:Fatou', 'photographer:Awa', 'cashier:Amy']);
  srv.close();
});
test('only an admin manages staff; the PIN is shown once at creation and never listed', async () => {
  const { srv, call } = await boot();
  assert.equal((await call('POST', '/api/admin/staff', { name: 'Fatou', role: 'host' }, 'm111')).status, 401);
  const made = (await call('POST', '/api/admin/staff', { name: 'Fatou', role: 'host' }, 'a111')).json;
  assert.match(made.pin, /^\d{6}$/);
  const listed = (await call('GET', '/api/admin/staff', null, 'a111')).json;
  assert.deepEqual(listed.map((s) => [s.name, s.role, s.active]), [['Fatou', 'host', true]]);
  assert.ok(!JSON.stringify(listed).includes(made.pin));
  assert.equal((await call('GET', '/api/admin/staff', null, made.pin)).status, 401); // a host cannot see or manage staff
  assert.equal((await call('POST', '/api/admin/staff', { name: 'Fatou', role: 'host' }, 'a111')).status, 400);
  const reset = (await call('POST', '/api/admin/staff/reset', { id: made.id }, 'a111')).json;
  assert.equal((await call('GET', '/api/queue?mall=1', null, made.pin)).status, 401);
  assert.equal((await call('GET', '/api/queue?mall=1', null, reset.pin)).status, 200);
  assert.equal((await call('POST', '/api/admin/staff/active', { id: made.id, active: false }, 'a111')).status, 200);
  assert.equal((await call('GET', '/api/queue?mall=1', null, reset.pin)).status, 401);
  const boss = (await call('POST', '/api/admin/staff', { name: 'Assane', role: 'admin' }, 'a111')).json; // personal admin PINs too
  assert.equal((await call('GET', '/api/admin/staff', null, boss.pin)).status, 200);
  srv.close();
});
