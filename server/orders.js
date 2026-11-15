const { priceOrder } = require('./pricing');
const { priceMap } = require('./db');
const { gallery } = require('./photos');

const PROVIDERS = { SN: ['Orange Money', 'Wave'], CI: ['Orange Money', 'Wave'], BJ: ['MTN MoMo', 'Celtiis Cash'] };
const DAY = 86400000;

const countryOf = (db, code) =>
  db.prepare('SELECT m.country FROM queue q JOIN malls m ON m.id=q.mall_id WHERE q.code=?').get(code)?.country;

function price(db, code, items) {
  const country = countryOf(db, code);
  if (!country) throw new Error('unknown code');
  return priceOrder(country, items, priceMap(db, country));
}

function saveCart(db, code, items, photoFiles) {
  const have = gallery(db, code) || [];
  if (photoFiles.some((f) => !have.includes(f))) throw new Error('photo not in gallery');
  const o = db.prepare('SELECT paid_at FROM orders WHERE code=?').get(code);
  if (o?.paid_at) throw new Error('already paid');
  if (!items.length) { // emptied cart: forget it so a stale one cannot be charged
    db.prepare('DELETE FROM orders WHERE code=?').run(code);
    return { lines: [], total: 0 };
  }
  const { lines, total } = price(db, code, items);
  db.prepare(`INSERT INTO orders(code,items_json,files_json,lines_json,total) VALUES(?,?,?,?,?)
    ON CONFLICT(code) DO UPDATE SET items_json=excluded.items_json, files_json=excluded.files_json, lines_json=excluded.lines_json, total=excluded.total`)
    .run(code, JSON.stringify(items), JSON.stringify(photoFiles), JSON.stringify(lines), total);
  return { lines, total };
}

function pay(db, code, p, now = new Date()) {
  const o = db.prepare('SELECT * FROM orders WHERE code=?').get(code);
  if (!o) throw new Error('no cart');
  if (o.paid_at) throw new Error('already paid');
  const { lines, total } = price(db, code, JSON.parse(o.items_json)); // never trust a client total
  if (p.expectedTotal !== total) throw new Error('total changed'); // cart changed after the cashier looked
  const bad = () => new Error('invalid payment');
  if (!p.cashier) throw bad();
  if (p.method === 'cash') {
    if (!(p.amountReceived >= total)) throw bad();
  } else if (p.method === 'mobile_money') {
    if (!PROVIDERS[countryOf(db, code)].includes(p.provider) || !String(p.reference || '').trim()) throw bad();
  } else throw bad();
  db.prepare(`UPDATE orders SET lines_json=?, total=?, method=?, provider=?, reference=?, amount_received=?, paid_at=?, cashier=?,
    print_state='ready', download_expires_at=? WHERE code=?`)
    .run(JSON.stringify(lines), total, p.method, p.provider || null, p.reference || null,
      p.method === 'cash' ? p.amountReceived : total, now.toISOString(), p.cashier,
      new Date(+now + 30 * DAY).toISOString(), code);
  return { total };
}

function nextPrintJob(db, mallId) {
  const o = db.prepare(`SELECT o.* FROM orders o JOIN queue q ON q.code=o.code
    WHERE q.mall_id=? AND o.print_state='ready' ORDER BY o.paid_at LIMIT 1`).get(mallId);
  return o ? { code: o.code, lines: JSON.parse(o.lines_json), files: JSON.parse(o.files_json) } : null;
}

function markPrinted(db, code) {
  db.prepare("UPDATE orders SET print_state='printed' WHERE code=?").run(code);
}

function download(db, code, now = new Date()) {
  const o = db.prepare('SELECT * FROM orders WHERE code=? AND paid_at IS NOT NULL').get(code);
  if (!o || now >= new Date(o.download_expires_at)) return null;
  const items = JSON.parse(o.items_json);
  const hasDigital = items.some((i) => i.item === 'digital' || ['essentiel', 'famille', 'prestige', 'numerique'].includes(i.item));
  return hasDigital ? JSON.parse(o.files_json) : null; // print-only orders get no files
}
module.exports = { saveCart, pay, nextPrintJob, markPrinted, download, PROVIDERS };
