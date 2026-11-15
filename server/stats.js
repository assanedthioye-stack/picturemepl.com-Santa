const { COUNTRIES, local, localDay, isDay } = require('./tz');
const { GRACE_MS } = require('./booking');

function check({ country = '', from, to }) {
  if (!isDay(from) || !isDay(to) || from > to || Date.parse(to) - Date.parse(from) > 366 * 86400000) throw new Error('bad range');
  if (country && !COUNTRIES.includes(country)) throw new Error('bad country');
}
const inRange = (day, from, to) => day >= from && day <= to;

// Paid orders whose LOCAL payment day falls in the range. country '' = all countries.
function paidOrders(db, { country = '', from, to }) {
  check({ country, from, to });
  return db.prepare(`SELECT o.*, m.name mall, m.country FROM orders o JOIN queue q ON q.code=o.code JOIN malls m ON m.id=q.mall_id
    WHERE o.paid_at IS NOT NULL AND (? = '' OR m.country = ?) ORDER BY o.paid_at`).all(country, country)
    .map((o) => ({ ...o, day: localDay(o.paid_at, o.country) })).filter((o) => inRange(o.day, from, to));
}

// KPI dashboard. All days and hours are local to each mall's country.
function dashboard(db, { country = '', from, to, now = new Date() }) {
  const paid = paidOrders(db, { country, from, to });
  const c = [country, country];
  const sum = (rows, key, val = 'total') => rows.reduce((a, r) => ((a[r[key]] = (a[r[key]] || 0) + r[val]), a), {});
  const tally = (rows, key) => rows.reduce((a, r) => ((a[r[key]] = (a[r[key]] || 0) + 1), a), {});
  const total = paid.reduce((s, o) => s + o.total, 0);

  const items = {};
  let discountedLines = 0;
  const byCashier = {};
  for (const o of paid) {
    for (const i of JSON.parse(o.items_json)) items[i.item] = (items[i.item] || 0) + i.qty;
    discountedLines += JSON.parse(o.lines_json).filter((l) => l.discounted).length;
    const x = (byCashier[o.cashier] ||= { cash: 0, mobile_money: 0 });
    x[o.method] += o.total;
  }
  const ordersByMall = tally(paid, 'mall');
  const byMall = Object.entries(sum(paid, 'mall')).map(([mall, t]) => ({ mall, total: t, orders: ordersByMall[mall] }));
  const revBy = sum(paid, 'day'), ordersBy = tally(paid, 'day');

  const q = db.prepare(`SELECT q.kind, q.checked_in_at, q.served_at, m.country FROM queue q JOIN malls m ON m.id=q.mall_id
    WHERE (? = '' OR m.country = ?)`).all(...c)
    .map((r) => ({ ...r, day: localDay(r.checked_in_at, r.country), servedDay: r.served_at && localDay(r.served_at, r.country) }))
    .filter((r) => inRange(r.day, from, to));
  const served = q.filter((r) => r.served_at);
  const slots = db.prepare(`SELECT s.id, s.start_at, s.capacity, m.country FROM slots s JOIN malls m ON m.id=s.mall_id
    WHERE (? = '' OR m.country = ?)`).all(...c)
    .map((s) => ({ ...s, day: localDay(s.start_at, s.country) })).filter((s) => inRange(s.day, from, to));
  const slotById = new Map(slots.map((s) => [s.id, s]));
  const bookings = db.prepare("SELECT slot_id, status FROM bookings WHERE status!='cancelled'").all()
    .filter((b) => slotById.has(b.slot_id)).map((b) => ({ ...b, ...slotById.get(b.slot_id), status: b.status }));
  const capacity = slots.reduce((s, x) => s + x.capacity, 0);
  const waits = served.map((r) => (Date.parse(r.served_at) - Date.parse(r.checked_in_at)) / 60000);

  const days = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86400000) days.push(new Date(t).toISOString().slice(0, 10));
  const servedBy = tally(served, 'servedDay'), bookedBy = tally(bookings, 'day');
  const trend = days.map((day) => ({ day, revenue: revBy[day] || 0, orders: ordersBy[day] || 0, served: servedBy[day] || 0, bookings: bookedBy[day] || 0 }));
  const peakHours = Array(24).fill(0); // arrivals by local hour
  for (const r of q) peakHours[+local(r.checked_in_at, r.country).slice(11, 13)]++;

  return {
    trend, peakHours,
    revenue: { total, orders: paid.length, avgOrder: paid.length ? Math.round(total / paid.length) : 0 },
    byDay: days.filter((d) => revBy[d]).map((day) => ({ day, total: revBy[day] })), byMall, byMethod: sum(paid, 'method'),
    byProvider: sum(paid.filter((o) => o.provider), 'provider'), byCashier, items, discountedLines,
    funnel: {
      bookings: bookings.length,
      noShows: bookings.filter((b) => b.status === 'booked' && Date.parse(b.start_at) + GRACE_MS < +now).length,
      walkins: q.filter((r) => r.kind === 'walkin').length,
      served: served.length, paid: paid.length,
      conversion: served.length ? Math.min(1, paid.length / served.length) : 0,
    },
    ops: { avgWaitMin: waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : 0, fillRate: capacity ? bookings.length / capacity : 0 },
  };
}
module.exports = { dashboard, paidOrders };
