// KPI dashboard. country '' = all countries; from/to are inclusive 'YYYY-MM-DD' days (UTC).
function dashboard(db, { country = '', from, to, now = new Date() }) {
  const day = /^\d{4}-\d\d-\d\d$/;
  if (!day.test(from) || !day.test(to)) throw new Error('bad range'); // from/to are inlined into SQL below
  if (country && !['SN', 'CI', 'BJ'].includes(country)) throw new Error('bad country');
  const c = [country, country];
  const range = (col) => `substr(${col},1,10) BETWEEN '${from}' AND '${to}'`;
  const cf = '(? = \'\' OR m.country = ?)';
  const paid = db.prepare(`SELECT o.*, m.name mall FROM orders o JOIN queue q ON q.code=o.code JOIN malls m ON m.id=q.mall_id
    WHERE o.paid_at IS NOT NULL AND ${range('o.paid_at')} AND ${cf}`).all(...c);

  const sum = (rows, key, val = 'total') => rows.reduce((a, r) => ((a[r[key]] = (a[r[key]] || 0) + r[val]), a), {});
  const total = paid.reduce((s, o) => s + o.total, 0);
  const items = {};
  let discountedLines = 0;
  for (const o of paid) {
    for (const i of JSON.parse(o.items_json)) items[i.item] = (items[i.item] || 0) + i.qty;
    discountedLines += JSON.parse(o.lines_json).filter((l) => l.discounted).length;
  }
  const byCashier = {};
  for (const o of paid) {
    const x = (byCashier[o.cashier] ||= { cash: 0, mobile_money: 0 });
    x[o.method] += o.total;
  }
  const byMall = Object.entries(sum(paid, 'mall')).map(([mall, t]) => ({ mall, total: t, orders: paid.filter((o) => o.mall === mall).length }));
  const byDay = Object.entries(sum(paid.map((o) => ({ ...o, day: o.paid_at.slice(0, 10) })), 'day'))
    .map(([day, t]) => ({ day, total: t })).sort((a, b) => a.day.localeCompare(b.day));

  const q = db.prepare(`SELECT q.kind, q.checked_in_at, q.served_at, m.country FROM queue q JOIN malls m ON m.id=q.mall_id
    WHERE ${range('q.checked_in_at')} AND ${cf}`).all(...c);
  const served = q.filter((r) => r.served_at);
  const bookings = db.prepare(`SELECT b.status, s.start_at FROM bookings b JOIN slots s ON s.id=b.slot_id JOIN malls m ON m.id=s.mall_id
    WHERE b.status!='cancelled' AND ${range('s.start_at')} AND ${cf}`).all(...c);
  const capacity = db.prepare(`SELECT COALESCE(SUM(s.capacity),0) n FROM slots s JOIN malls m ON m.id=s.mall_id
    WHERE ${range('s.start_at')} AND ${cf}`).get(...c).n;
  const waits = served.map((r) => (Date.parse(r.served_at) - Date.parse(r.checked_in_at)) / 60000);

  const days = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86400000) days.push(new Date(t).toISOString().slice(0, 10));
  const tally = (rows, dayOf) => rows.reduce((a, r) => ((a[dayOf(r)] = (a[dayOf(r)] || 0) + 1), a), {});
  const servedBy = tally(served, (r) => r.served_at.slice(0, 10));
  const bookedBy = tally(bookings, (r) => r.start_at.slice(0, 10));
  const ordersBy = tally(paid, (r) => r.paid_at.slice(0, 10));
  const revBy = sum(paid.map((o) => ({ ...o, day: o.paid_at.slice(0, 10) })), 'day');
  const trend = days.map((day) => ({ day, revenue: revBy[day] || 0, orders: ordersBy[day] || 0, served: servedBy[day] || 0, bookings: bookedBy[day] || 0 }));
  const peakHours = Array(24).fill(0); // arrivals by local hour; Benin is UTC+1, Senegal and Côte d'Ivoire UTC
  for (const r of q) peakHours[(new Date(r.checked_in_at).getUTCHours() + (r.country === 'BJ' ? 1 : 0)) % 24]++;

  return {
    trend, peakHours,
    revenue: { total, orders: paid.length, avgOrder: paid.length ? Math.round(total / paid.length) : 0 },
    byDay, byMall, byMethod: sum(paid, 'method'),
    byProvider: sum(paid.filter((o) => o.provider), 'provider'), byCashier, items, discountedLines,
    funnel: {
      bookings: bookings.length,
      noShows: bookings.filter((b) => b.status === 'booked' && Date.parse(b.start_at) + 30 * 60000 < now).length,
      walkins: q.filter((r) => r.kind === 'walkin').length,
      served: served.length, paid: paid.length,
      conversion: served.length ? paid.length / served.length : 0,
    },
    ops: { avgWaitMin: waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : 0, fillRate: capacity ? bookings.length / capacity : 0 },
  };
}
module.exports = { dashboard };
