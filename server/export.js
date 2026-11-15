const { dashboard } = require('./stats');

// Semicolon-separated with a BOM: French-locale Excel opens this directly. Cells starting with = + - @ are
// prefixed with ' so a typed reference like =HYPERLINK(...) cannot run as a formula.
const cell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csv = (rows) => '﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';

function ordersCsv(db, { country = '', from, to }) {
  dashboard(db, { country, from, to }); // reuses its input validation
  const rows = db.prepare(`SELECT o.*, m.name mall, m.country FROM orders o JOIN queue q ON q.code=o.code JOIN malls m ON m.id=q.mall_id
    WHERE o.paid_at IS NOT NULL AND substr(o.paid_at,1,10) BETWEEN ? AND ? AND (? = '' OR m.country = ?) ORDER BY o.paid_at`).all(from, to, country, country);
  return csv([['paid_at', 'country', 'mall', 'code', 'items', 'total_xof', 'method', 'provider', 'reference', 'cashier'],
    ...rows.map((o) => [o.paid_at, o.country, o.mall, o.code, JSON.parse(o.items_json).map((i) => `${i.qty}x ${i.item}`).join(' + '),
      o.total, o.method, o.provider, o.reference, o.cashier])]);
}

function dailyCsv(db, opts) {
  return csv([['day', 'revenue_xof', 'orders', 'served', 'bookings'],
    ...dashboard(db, opts).trend.map((d) => [d.day, d.revenue, d.orders, d.served, d.bookings])]);
}
module.exports = { ordersCsv, dailyCsv };
