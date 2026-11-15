const { tx, mallById } = require('./db');
const { COUNTRIES, offsetMs, localDay, isDay } = require('./tz');
const { cleanText } = require('./booking');

function dailySales(db, mallId, day) {
  const mall = mallById(db, mallId);
  if (!isDay(day)) throw new Error('bad range');
  const rows = db.prepare(`SELECT o.total, o.method, o.provider, o.paid_at FROM orders o JOIN queue q ON q.code=o.code
    WHERE q.mall_id=? AND o.paid_at IS NOT NULL`).all(mall.id).filter((r) => localDay(r.paid_at, mall.country) === day);
  const out = { total: 0, byMethod: {}, byProvider: {} };
  for (const r of rows) {
    out.total += r.total;
    out.byMethod[r.method] = (out.byMethod[r.method] || 0) + r.total;
    if (r.provider) out.byProvider[r.provider] = (out.byProvider[r.provider] || 0) + r.total;
  }
  return out;
}

function setPrice(db, country, item, amount) {
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 10000000) throw new Error('bad amount');
  const r = db.prepare('UPDATE prices SET amount=? WHERE country=? AND item=?').run(amount, String(country), String(item));
  if (!r.changes) throw new Error('unknown price');
}

// Creates every slot from open to close for each day, in the mall's local time.
function addSlots(db, /** @type {any} */ opts) {
  const { mall, fromDay, toDay, open, close, minutes, capacity } = opts || {};
  const bad = () => new Error('bad slots');
  const hm = /^([01]\d|2[0-3]):[0-5]\d$/;
  let m;
  try { m = mallById(db, mall); } catch { throw bad(); }
  if (!isDay(fromDay) || !isDay(toDay) || !hm.test(open) || !hm.test(close)) throw bad();
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 240 || !Number.isInteger(capacity) || capacity < 1 || capacity > 100) throw bad();
  const days = (Date.parse(toDay) - Date.parse(fromDay)) / 86400000 + 1;
  const mins = (t) => +t.slice(0, 2) * 60 + +t.slice(3);
  if (!(days >= 1 && days <= 62) || mins(close) <= mins(open)) throw bad();
  return tx(db, () => {
    const exists = db.prepare('SELECT 1 FROM slots WHERE mall_id=? AND start_at=?');
    const ins = db.prepare('INSERT INTO slots(mall_id,start_at,capacity) VALUES(?,?,?)');
    let created = 0;
    for (let d = 0; d < days; d++) {
      const dayStart = Date.parse(fromDay) + d * 86400000;
      for (let t = mins(open); t + minutes <= mins(close); t += minutes) {
        const start = new Date(dayStart + t * 60000 - offsetMs(m.country)).toISOString();
        if (!exists.get(m.id, start)) { ins.run(m.id, start, capacity); created++; }
      }
    }
    return { created };
  });
}

function addMall(db, name, country) {
  const n = cleanText(name, 60);
  if (!n || !COUNTRIES.includes(country)) throw new Error('bad mall');
  if (db.prepare('SELECT 1 FROM malls WHERE lower(name)=lower(?) AND country=?').get(n, country)) throw new Error('bad mall'); // no duplicates
  db.prepare('INSERT INTO malls(name,country) VALUES(?,?)').run(n, country);
}
module.exports = { dailySales, setPrice, addSlots, addMall };
