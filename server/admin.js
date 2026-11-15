function dailySales(db, mallId, day) {
  const rows = db.prepare(`SELECT o.total, o.method, o.provider FROM orders o JOIN queue q ON q.code=o.code
    WHERE q.mall_id=? AND o.paid_at LIKE ?`).all(mallId, day + '%');
  const out = { total: 0, byMethod: {}, byProvider: {} };
  for (const r of rows) {
    out.total += r.total;
    out.byMethod[r.method] = (out.byMethod[r.method] || 0) + r.total;
    if (r.provider) out.byProvider[r.provider] = (out.byProvider[r.provider] || 0) + r.total;
  }
  return out;
}

function setPrice(db, country, item, amount) {
  if (!Number.isInteger(amount) || amount < 0) throw new Error('bad amount');
  const r = db.prepare('UPDATE prices SET amount=? WHERE country=? AND item=?').run(amount, country, item);
  if (!r.changes) throw new Error('unknown price');
}

function addSlot(db, mallId, startAt, capacity) {
  if (isNaN(Date.parse(startAt)) || !(capacity > 0)) throw new Error('bad slot');
  db.prepare('INSERT INTO slots(mall_id,start_at,capacity) VALUES(?,?,?)').run(mallId, new Date(startAt).toISOString(), capacity);
}
module.exports = { dailySales, setPrice, addSlot };
