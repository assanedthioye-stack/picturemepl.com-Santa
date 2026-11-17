const crypto = require('node:crypto');
const { priceOrder } = require('./pricing');
const { priceMap, tx } = require('./db');
const { gallery } = require('./photos');
const { cleanText } = require('./booking');
const { setPresence } = require('./queue');

const PROVIDERS = { SN: ['Orange Money', 'Wave'], CI: ['Orange Money', 'Wave'], BJ: ['MTN MoMo', 'Celtiis Cash'] };
const DIGITAL = ['digital', 'essentiel', 'famille', 'prestige', 'numerique']; // items that include a digital file
const DAY = 86400000;

const countryOf = (db, code) =>
  db.prepare('SELECT m.country FROM queue q JOIN malls m ON m.id=q.mall_id WHERE q.code=?').get(String(code || ''))?.country;

function price(db, code, items) {
  const country = countryOf(db, code);
  if (!country) throw new Error('unknown code');
  return priceOrder(country, items, priceMap(db, country));
}

function saveCart(db, code, items, photoFiles = []) {
  if (!Array.isArray(items) || !Array.isArray(photoFiles) || items.length > 20) throw new Error('bad item');
  return tx(db, () => {
    const have = gallery(db, code);
    if (!have) throw new Error('unknown code');
    if (photoFiles.some((f) => !have.includes(f))) throw new Error('photo not in gallery');
    if (db.prepare('SELECT paid_at FROM orders WHERE code=?').get(code)?.paid_at) throw new Error('already paid');
    if (!items.length) { // emptied cart: forget it so a stale one cannot be charged
      db.prepare('DELETE FROM orders WHERE code=?').run(code);
      return { lines: [], total: 0 };
    }
    const { lines, total } = price(db, code, items);
    db.prepare(`INSERT INTO orders(code,items_json,files_json,lines_json,total) VALUES(?,?,?,?,?)
      ON CONFLICT(code) DO UPDATE SET items_json=excluded.items_json, files_json=excluded.files_json, lines_json=excluded.lines_json, total=excluded.total`)
      .run(code, JSON.stringify(items), JSON.stringify([...new Set(photoFiles)]), JSON.stringify(lines), total);
    return { lines, total };
  });
}

function pay(db, code, /** @type {any} */ p, now = new Date()) {
  p = p || {};
  return tx(db, () => {
    const o = db.prepare('SELECT * FROM orders WHERE code=?').get(String(code || ''));
    if (!o) throw new Error('no cart');
    if (o.paid_at) throw new Error('already paid');
    if (!JSON.parse(o.files_json).length) throw new Error('no photos'); // nothing would print or download
    const { lines, total } = price(db, code, JSON.parse(o.items_json)); // never trust a client total
    if (p.expectedTotal !== total) throw new Error('total changed'); // cart changed after the cashier looked
    const bad = () => new Error('invalid payment');
    const cashier = cleanText(p.cashier, 40), reference = cleanText(p.reference, 60);
    if (!cashier) throw bad();
    if (p.method === 'cash') {
      if (!Number.isSafeInteger(p.amountReceived) || p.amountReceived < total) throw bad();
    } else if (p.method === 'mobile_money') {
      if (!PROVIDERS[countryOf(db, code)].includes(p.provider) || !reference) throw bad();
      // One operator receipt pays one order: a reused reference would record money that was received only once.
      if (db.prepare('SELECT 1 FROM orders WHERE provider=? AND upper(reference)=upper(?) AND paid_at IS NOT NULL').get(p.provider, reference)) throw new Error('reference used');
    } else throw bad();
    const momo = p.method === 'mobile_money';
    // A digital purchase gets a private, unguessable link for the family. It is the only way a non-admin receives a clean file.
    const token = JSON.parse(o.items_json).some((i) => DIGITAL.includes(i.item)) ? crypto.randomBytes(16).toString('hex') : null;
    db.prepare(`UPDATE orders SET lines_json=?, total=?, method=?, provider=?, reference=?, amount_received=?, paid_at=?, cashier=?,
      print_state='ready', download_expires_at=?, download_token=? WHERE code=?`)
      .run(JSON.stringify(lines), total, p.method, momo ? p.provider : null, momo ? reference : null,
        momo ? total : p.amountReceived, now.toISOString(), cashier, new Date(+now + 30 * DAY).toISOString(), token, o.code);
    const mall = db.prepare('SELECT mall_id FROM queue WHERE code=?').get(o.code);
    if (mall) setPresence(db, mall.mall_id, 'cashier', cashier, now);
    return { total };
  });
}

function getOrder(db, code) {
  const o = db.prepare('SELECT * FROM orders WHERE code=?').get(String(code || ''));
  const country = countryOf(db, code);
  if (!o || !country) throw new Error('unknown code');
  return { lines: JSON.parse(o.lines_json), total: o.total, photos: JSON.parse(o.files_json).length, paid: !!o.paid_at, method: o.method,
    provider: o.provider, print_state: o.print_state, country };
}

// The family link of a paid digital order, for the cashier to show. Throws 'not found' when there is none.
function deliveryFor(db, code, now = new Date()) {
  const o = db.prepare('SELECT download_token, download_expires_at FROM orders WHERE code=? AND paid_at IS NOT NULL').get(String(code || ''));
  if (!o || !o.download_token || !download(db, code, now)) throw new Error('not found');
  return { token: o.download_token, expires: o.download_expires_at };
}

// What a family link gives access to: the photos they bought, until the link expires.
function delivery(db, token, now = new Date()) {
  const o = /^[0-9a-f]{32}$/.test(String(token)) ? db.prepare('SELECT code, download_expires_at FROM orders WHERE download_token=?').get(token) : null;
  const files = o && download(db, o.code, now);
  if (!files) throw new Error('not found');
  return { code: o.code, files, expires: o.download_expires_at };
}

// Photos of an order whose payment is confirmed: the only files the printer may fetch clean.
function paidFiles(db, code) {
  const o = db.prepare('SELECT files_json FROM orders WHERE code=? AND paid_at IS NOT NULL').get(String(code || ''));
  return o ? JSON.parse(o.files_json) : [];
}

// For the admin: every photo of a family, which ones they chose, and whether they bought digital files.
function adminFiles(db, code) {
  const files = gallery(db, code);
  if (!files) throw new Error('unknown code');
  const o = db.prepare('SELECT files_json, paid_at FROM orders WHERE code=?').get(String(code || ''));
  return { files, chosen: o ? JSON.parse(o.files_json) : [], paid: !!(o && o.paid_at), digital: download(db, code) !== null };
}

function nextPrintJob(db, mallId) {
  const o = db.prepare(`SELECT o.* FROM orders o JOIN queue q ON q.code=o.code
    WHERE q.mall_id=? AND o.print_state='ready' ORDER BY o.paid_at LIMIT 1`).get(mallId);
  return o ? { code: o.code, lines: JSON.parse(o.lines_json), files: JSON.parse(o.files_json) } : null;
}

function markPrinted(db, code) {
  const r = db.prepare("UPDATE orders SET print_state='printed' WHERE code=? AND print_state='ready'").run(String(code || ''));
  if (!r.changes) throw new Error('unknown code');
}

function download(db, code, now = new Date()) {
  const o = db.prepare('SELECT * FROM orders WHERE code=? AND paid_at IS NOT NULL').get(String(code || ''));
  if (!o || now >= new Date(o.download_expires_at)) return null;
  const hasDigital = JSON.parse(o.items_json).some((i) => DIGITAL.includes(i.item));
  return hasDigital ? JSON.parse(o.files_json) : null; // print-only orders bought no digital file
}
module.exports = { saveCart, pay, getOrder, deliveryFor, delivery, paidFiles, adminFiles, nextPrintJob, markPrinted, download, PROVIDERS };
