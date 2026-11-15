const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../server/db');
const { addSlots } = require('../server/admin');

function setup() {
  const db = openDb();
  db.prepare("INSERT INTO malls(id,name,country) VALUES(1,'Dakar','SN'),(2,'Cotonou','BJ')").run();
  return db;
}
const base = { mall: 1, fromDay: '2026-12-20', toDay: '2026-12-21', open: '10:00', close: '12:00', minutes: 30, capacity: 3 };
const starts = (db, mall) => db.prepare('SELECT start_at FROM slots WHERE mall_id=? ORDER BY start_at').all(mall).map((r) => r.start_at);

test('creates every slot for every day with the chosen capacity', () => {
  const db = setup();
  assert.equal(addSlots(db, base).created, 8); // 4 per day x 2 days
  assert.equal(db.prepare('SELECT DISTINCT capacity c FROM slots').all()[0].c, 3);
});
test('the last slot must end by closing time', () => {
  const db = setup();
  assert.equal(addSlots(db, { ...base, toDay: base.fromDay, close: '11:45' }).created, 3); // 10:00, 10:30, 11:00
});
test('local time is stored as UTC: Senegal +0, Benin +1', () => {
  const db = setup();
  addSlots(db, { ...base, toDay: base.fromDay });
  addSlots(db, { ...base, mall: 2, toDay: base.fromDay });
  assert.equal(starts(db, 1)[0], '2026-12-20T10:00:00.000Z');
  assert.equal(starts(db, 2)[0], '2026-12-20T09:00:00.000Z');
});
test('running it twice does not duplicate slots', () => {
  const db = setup();
  addSlots(db, base);
  assert.equal(addSlots(db, base).created, 0);
  assert.equal(starts(db, 1).length, 8);
});
test('bad input is rejected', () => {
  const db = setup();
  for (const bad of [{ close: '10:00' }, { minutes: 1 }, { capacity: 0 }, { toDay: '2027-03-01' }, { fromDay: 'x' }, { mall: 99 }, { toDay: '2026-12-19' }]) {
    assert.throws(() => addSlots(db, { ...base, ...bad }), /bad slots/, JSON.stringify(bad));
  }
});
