const test = require('node:test');
const assert = require('node:assert');
const { seed, T } = require('./seed');
const { ordersCsv, dailyCsv } = require('../server/export');
const R = { from: '2026-12-20', to: '2026-12-20', now: T(120) };

test('orders csv: BOM, semicolons, one row per paid order, filtered by country', () => {
  const csv = ordersCsv(seed(), { ...R, country: 'SN' });
  assert.ok(csv.startsWith('\uFEFF'));
  const rows = csv.slice(1).trim().split('\r\n');
  assert.equal(rows.length, 3); // header + 2
  assert.equal(rows[0], 'paid_at;country;mall;code;items;total_xof;method;provider;reference;cashier');
  assert.ok(rows[1].includes(';SN;Sea Plaza;') && rows[1].includes(';12800;cash;;;amy'));
  assert.equal(ordersCsv(seed(), { ...R, country: 'CI' }).trim().split('\r\n').length, 2);
});
test('csv neutralises spreadsheet formulas and quotes separators', () => {
  const db = seed();
  db.prepare("UPDATE orders SET reference='=HYPERLINK(\"x\")', cashier='a;b' WHERE cashier='bob'").run();
  const csv = ordersCsv(db, { ...R, country: 'SN' });
  assert.ok(csv.includes("'=HYPERLINK"));
  assert.ok(csv.includes('"a;b"'));
});
test('daily csv has one row per day with zeros', () => {
  const rows = dailyCsv(seed(), { ...R, to: '2026-12-21', country: 'SN' }).slice(1).trim().split('\r\n');
  assert.equal(rows[0], 'day;revenue_xof;orders;served;bookings');
  assert.deepEqual(rows.slice(1), ['2026-12-20;26300;2;2;1', '2026-12-21;0;0;0;0']);
});
