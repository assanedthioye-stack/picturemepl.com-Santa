const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../server/db');
const { addWalkIn, serveNext } = require('../server/queue');
const { saveCart, pay, nextPrintJob, markPrinted, download } = require('../server/orders');

const DAY = 86400000;
function setup(country = 'SN') {
  const db = openDb();
  db.prepare("INSERT INTO malls(id,name,country) VALUES(1,'M',?)").run(country);
  const code = addWalkIn(db, 1, { name: 'A', phone: '+221700000000', consent: true }).code;
  serveNext(db, 1);
  db.prepare("INSERT INTO photos(code,file) VALUES(?,'1_a.jpg')").run(code);
  const file = db.prepare('SELECT file FROM photos').get().file;
  saveCart(db, code, [{ item: 'famille', qty: 1 }], [file]);
  return { db, code };
}
const cash = (o = {}) => ({ method: 'cash', amountReceived: 10000, expectedTotal: 10000, cashier: 'c', ...o });
const momo = (o = {}) => ({ method: 'mobile_money', provider: 'Wave', reference: 'TX1', expectedTotal: 10000, cashier: 'c', ...o });
const now = new Date('2026-12-20T10:00:00Z');

test('unpaid order is not in the print queue; paid is', () => {
  const { db, code } = setup();
  assert.equal(nextPrintJob(db, 1), null);
  pay(db, code, cash(), now);
  assert.equal(nextPrintJob(db, 1).code, code);
});
test('mobile money needs a reference', () => {
  const { db, code } = setup();
  assert.throws(() => pay(db, code, momo({ reference: '' }), now), /invalid payment/);
});
test('Orange Money invalid in Benin, Celtiis Cash valid', () => {
  const { db, code } = setup('BJ');
  assert.throws(() => pay(db, code, momo({ provider: 'Orange Money', expectedTotal: 8500 }), now), /invalid payment/);
  assert.equal(pay(db, code, momo({ provider: 'Celtiis Cash', expectedTotal: 8500 }), now).total, 8500);
});
test('cash below total throws', () => {
  const { db, code } = setup();
  assert.throws(() => pay(db, code, cash({ amountReceived: 5000 }), now), /invalid payment/);
});
test('server computes total, ignoring client total', () => {
  const { db, code } = setup();
  assert.equal(pay(db, code, { ...cash(), total: 1 }, now).total, 10000);
});
test('download valid at day 29, null at day 31, null when unpaid', () => {
  const { db, code } = setup();
  assert.equal(download(db, code, now), null);
  pay(db, code, cash(), now);
  assert.equal(download(db, code, new Date(+now + 29 * DAY)).length, 1);
  assert.equal(download(db, code, new Date(+now + 31 * DAY)), null);
});
test('markPrinted removes from queue', () => {
  const { db, code } = setup();
  pay(db, code, cash(), now);
  markPrinted(db, code);
  assert.equal(nextPrintJob(db, 1), null);
});
test('cannot change cart after payment', () => {
  const { db, code } = setup();
  pay(db, code, cash(), now);
  assert.throws(() => saveCart(db, code, [{ item: 'prestige', qty: 1 }], []), /already paid/);
});

test('pay rejects when the total changed since the cashier looked', () => {
  const { db, code } = setup();
  assert.throws(() => pay(db, code, cash({ expectedTotal: 5000 }), now), /total changed/);
});
test('prototype keys are not items', () => {
  const { db, code } = setup();
  assert.throws(() => saveCart(db, code, [{ item: 'constructor', qty: 1 }], []), /bad item/);
});
test('emptying the cart removes it; empty order cannot be paid', () => {
  const { db, code } = setup();
  saveCart(db, code, [], []);
  assert.throws(() => pay(db, code, cash(), now), /no cart/);
});
test('print-only order has no digital download', () => {
  const { db, code } = setup();
  const file = db.prepare('SELECT file FROM photos').get().file;
  saveCart(db, code, [{ item: 'famille', qty: 1 }, { item: 'print_8x10', qty: 1 }], [file]);
  saveCart(db, code, [{ item: 'print_8x10', qty: 1 }], [file]);
  pay(db, code, cash({ expectedTotal: 3500, amountReceived: 3500 }), now);
  assert.equal(download(db, code, now), null);
});
