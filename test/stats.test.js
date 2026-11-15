const test = require('node:test');
const assert = require('node:assert');
const { dashboard } = require('../server/stats');

const { T, seed } = require('./seed');
const R = { from: '2026-12-20', to: '2026-12-20', now: T(120) };

test('revenue, orders and average order value, filtered by country', () => {
  const db = seed();
  const sn = dashboard(db, { ...R, country: 'SN' });
  assert.deepEqual([sn.revenue.total, sn.revenue.orders, sn.revenue.avgOrder], [26300, 2, 13150]);
  assert.equal(dashboard(db, { ...R, country: 'CI' }).revenue.total, 6000);
  assert.equal(dashboard(db, { ...R, country: '' }).revenue.total, 32300);
});
test('payment split and per-cashier totals', () => {
  const sn = dashboard(seed(), { ...R, country: 'SN' });
  assert.deepEqual(sn.byMethod, { cash: 12800, mobile_money: 13500 });
  assert.deepEqual(sn.byProvider, { Wave: 13500 });
  assert.deepEqual(sn.byCashier, { amy: { cash: 12800, mobile_money: 0 }, bob: { cash: 0, mobile_money: 13500 } });
});
test('package mix and discount usage', () => {
  const sn = dashboard(seed(), { ...R, country: 'SN' });
  assert.equal(sn.items.essentiel, 2);
  assert.equal(sn.items.famille, 1);
  assert.equal(sn.discountedLines, 2);
});
test('funnel: bookings, no-shows, walk-ins, served, paid, conversion', () => {
  const f = dashboard(seed(), { ...R, country: 'SN' }).funnel;
  assert.deepEqual([f.bookings, f.noShows, f.walkins, f.served, f.paid, f.conversion], [1, 1, 2, 2, 2, 1]);
});
test('operations: average wait and slot fill rate', () => {
  const o = dashboard(seed(), { ...R, country: 'SN' }).ops;
  assert.equal(o.avgWaitMin, 10);
  assert.equal(o.fillRate, 0.2);
});
test('bad date range or country is rejected', () => {
  const db = seed();
  assert.throws(() => dashboard(db, { ...R, from: "x' OR 1=1 --" }), /bad range/);
  assert.throws(() => dashboard(db, { ...R, country: 'XX' }), /bad country/);
});
test('by-day revenue and date range exclude other days', () => {
  const db = seed();
  assert.deepEqual(dashboard(db, { ...R, country: 'SN' }).byDay, [{ day: '2026-12-20', total: 26300 }]);
  assert.equal(dashboard(db, { ...R, from: '2026-12-21', to: '2026-12-22', country: 'SN' }).revenue.total, 0);
});

test('trend fills every day of the range with zeros', () => {
  const tr = dashboard(seed(), { ...R, to: '2026-12-22', country: 'SN' }).trend;
  assert.deepEqual(tr.map((d) => d.day), ['2026-12-20', '2026-12-21', '2026-12-22']);
  assert.deepEqual(tr[0], { day: '2026-12-20', revenue: 26300, orders: 2, served: 2, bookings: 1 });
  assert.deepEqual(tr[1], { day: '2026-12-21', revenue: 0, orders: 0, served: 0, bookings: 0 });
});
test('peak hours count arrivals by local hour (Benin is UTC+1)', () => {
  const db = seed();
  db.prepare("INSERT INTO malls(id,name,country) VALUES(3,'Cotonou','BJ')").run();
  require('../server/queue').addWalkIn(db, 3, { name: 'z', phone: '1', consent: true }, T(0));
  assert.equal(dashboard(db, { ...R, country: 'SN' }).peakHours[10], 2);
  assert.equal(dashboard(db, { ...R, country: 'BJ' }).peakHours[11], 1);
  assert.equal(dashboard(db, { ...R, country: '' }).peakHours[10], 3);
});
