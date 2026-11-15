const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../server/db');
const { book } = require('../server/booking');
const { checkIn, addWalkIn, getQueue, serveNext } = require('../server/queue');

const T = (m) => new Date(Date.parse('2026-12-20T10:00:00Z') + m * 60000);
function setup() {
  const db = openDb();
  db.prepare("INSERT INTO malls(id,name,country) VALUES(1,'M','SN')").run();
  db.prepare("INSERT INTO slots(id,mall_id,start_at,capacity) VALUES(1,1,'2026-12-20T10:00:00Z',5),(2,1,'2026-12-20T10:15:00Z',5)").run();
  return db;
}
const b = (db, slotId) => book(db, { slotId, name: 'F' + slotId, phone: '+221700000000', consent: true }).code;

test('29 min after slot is appointment, 31 is walkin', () => {
  const db = setup();
  assert.equal(checkIn(db, b(db, 1), T(29)).kind, 'appointment');
  assert.equal(checkIn(db, b(db, 1), T(31)).kind, 'walkin');
});
test('same code twice does not duplicate', () => {
  const db = setup();
  const c = b(db, 1);
  checkIn(db, c, T(0));
  checkIn(db, c, T(1));
  assert.equal(getQueue(db, 1).length, 1);
});
test('order: appointments by slot, then walk-ins by arrival', () => {
  const db = setup();
  const w = addWalkIn(db, 1, { name: 'W', phone: '+221700000000', consent: true }, T(0)).code;
  const a2 = b(db, 2), a1 = b(db, 1);
  checkIn(db, a2, T(2));
  checkIn(db, a1, T(3));
  assert.deepEqual(getQueue(db, 1).map((x) => x.code), [a1, a2, w]);
  assert.equal(serveNext(db, 1).code, a1);
  assert.equal(serveNext(db, 1).code, a2);
  assert.equal(serveNext(db, 1).code, w);
  assert.equal(serveNext(db, 1), null);
});
test('walk-in without consent throws', () =>
  assert.throws(() => addWalkIn(setup(), 1, { name: 'W', phone: '+221700000000', consent: false }, T(0)), /consent/));
test('unknown code throws', () => assert.throws(() => checkIn(setup(), 'ZZZZZZZZ', T(0)), /unknown code/));

test('next is blocked while the served family has an unpaid cart, unless forced', () => {
  const db = setup();
  const a = addWalkIn(db, 1, { name: 'A', phone: '+221700000000', consent: true }, T(0)).code;
  addWalkIn(db, 1, { name: 'B', phone: '+221700000000', consent: true }, T(1));
  serveNext(db, 1);
  db.prepare("INSERT INTO orders(code,items_json,files_json,lines_json,total) VALUES(?,?,?,?,?)").run(a, '[]', '[]', '[]', 10000);
  assert.throws(() => serveNext(db, 1), /unpaid order/);
  assert.equal(serveNext(db, 1, { force: true }).name, 'B');
});
