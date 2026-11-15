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
// Creates every slot from open to close for each day, in the mall's local time (Benin is UTC+1, the rest UTC+0).
function addSlots(db, { mall, fromDay, toDay, open, close, minutes, capacity }) {
  const bad = () => new Error('bad slots');
  const day = /^\d{4}-\d\d-\d\d$/, hm = /^([01]\d|2[0-3]):[0-5]\d$/;
  const m = db.prepare('SELECT country FROM malls WHERE id=?').get(mall);
  if (!m || !day.test(fromDay) || !day.test(toDay) || !hm.test(open) || !hm.test(close)) throw bad();
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 240 || !Number.isInteger(capacity) || capacity < 1 || capacity > 100) throw bad();
  const days = (Date.parse(toDay) - Date.parse(fromDay)) / 86400000 + 1;
  const mins = (t) => +t.slice(0, 2) * 60 + +t.slice(3);
  if (!(days >= 1 && days <= 62) || mins(close) <= mins(open)) throw bad();
  const offset = (m.country === 'BJ' ? -1 : 0) * 3600000;
  const exists = db.prepare('SELECT 1 FROM slots WHERE mall_id=? AND start_at=?');
  const ins = db.prepare('INSERT INTO slots(mall_id,start_at,capacity) VALUES(?,?,?)');
  let created = 0;
  for (let d = 0; d < days; d++) {
    const dayStart = Date.parse(fromDay) + d * 86400000;
    for (let t = mins(open); t + minutes <= mins(close); t += minutes) {
      const start = new Date(dayStart + t * 60000 + offset).toISOString();
      if (!exists.get(mall, start)) { ins.run(mall, start, capacity); created++; }
    }
  }
  return { created };
}

function addMall(db, name, country) {
  if (!String(name || '').trim() || !['SN', 'CI', 'BJ'].includes(country)) throw new Error('bad mall');
  db.prepare('INSERT INTO malls(name,country) VALUES(?,?)').run(String(name).trim(), country);
}
module.exports = { dailySales, setPrice, addSlot, addSlots, addMall };
