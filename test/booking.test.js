const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../server/db');
const { listSlots, book, cancel } = require('../server/booking');

function setup(capacity = 2) {
  const db = openDb();
  db.prepare("INSERT INTO malls(id,name,country) VALUES(1,'Test Mall','SN')").run();
  db.prepare("INSERT INTO slots(id,mall_id,start_at,capacity) VALUES(1,1,'2026-12-20T10:00:00Z',?)").run(capacity);
  return db;
}
const p = (o = {}) => ({ slotId: 1, name: 'Awa', phone: '+221700000000', consent: true, ...o });

test('remaining decreases after book', () => {
  const db = setup();
  book(db, p());
  assert.equal(listSlots(db, 1, '2026-12-20')[0].remaining, 1);
});
test('booking beyond capacity throws full', () => {
  const db = setup(1);
  book(db, p());
  assert.throws(() => book(db, p()), /full/);
});
test('no consent throws', () => assert.throws(() => book(setup(), p({ consent: false })), /consent/));
test('cancel frees the slot', () => {
  const db = setup(1);
  const { code } = book(db, p());
  cancel(db, code);
  assert.equal(listSlots(db, 1, '2026-12-20')[0].remaining, 1);
  book(db, p());
});
test('codes are unique across 1000 bookings', () => {
  const db = setup(1000);
  const s = new Set();
  for (let i = 0; i < 1000; i++) s.add(book(db, p()).code);
  assert.equal(s.size, 1000);
});
