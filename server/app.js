const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const QRCode = require('qrcode');
const { mallById } = require('./db');
const booking = require('./booking');
const queue = require('./queue');
const photos = require('./photos');
const orders = require('./orders');
const admin = require('./admin');
const stats = require('./stats');
const exp = require('./export');

const PUBLIC = path.resolve(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
// Errors the modules raise on purpose, and the status each one maps to. Anything else is a bug: logged, answered as 500.
const KNOWN = {
  consent: 400, 'name and phone required': 400, 'name required': 400, 'bad day': 400, 'bad item': 400, 'bad amount': 400, 'bad slots': 400,
  'bad mall': 400, 'bad range': 400, 'bad country': 400, 'bad file': 400, 'bad json': 400, 'invalid payment': 400, 'photo not in gallery': 400,
  'no photos': 400, 'no cart': 404, 'unknown code': 404, 'unknown slot': 404, 'unknown mall': 404, 'unknown price': 404, 'not found': 404,
  full: 409, past: 409, 'already paid': 409, 'total changed': 409, 'unpaid order': 409, 'no active family': 409, 'wrong mall': 409,
  'too large': 413, 'too many attempts': 429, pin: 401,
};
const HEADERS = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' };
const MAX_JSON = 100e3, MAX_PHOTO = 40e6;

// Fixed-window counter per key (an IP): allow `max` hits per `windowMs`.
function limiter(max, windowMs) {
  const hits = new Map();
  return {
    blocked(key, now = Date.now()) { const h = hits.get(key); return !!h && h.reset > now && h.count >= max; },
    hit(key, now = Date.now()) {
      if (hits.size > 5000) for (const [k, h] of hits) if (h.reset <= now) hits.delete(k);
      const h = hits.get(key);
      if (!h || h.reset <= now) hits.set(key, { count: 1, reset: now + windowMs });
      else h.count++;
    },
  };
}

function createServer({ db, dir, pins, log = console.error }) {
  const roles = Object.entries(pins).filter(([, p]) => typeof p === 'string' && p.length >= 4);
  const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const roleOf = (pin) => roles.find(([, p]) => same(p, pin))?.[0];
  const badPins = limiter(20, 10 * 60000); // PIN guessing
  const bookings = limiter(60, 60 * 60000); // slot-hoarding by one address

  async function readBody(req, max) {
    const chunks = [];
    let n = 0;
    for await (const c of req) { n += c.length; if (n > max) throw new Error('too large'); chunks.push(c); }
    return Buffer.concat(chunks);
  }
  async function json(req) {
    const buf = await readBody(req, MAX_JSON);
    let v;
    try { v = buf.length ? JSON.parse(buf.toString('utf8')) : {}; } catch { throw new Error('bad json'); }
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('bad json');
    return v;
  }
  const int = (v) => (typeof v === 'number' ? v : /^\d{1,9}$/.test(String(v ?? '')) ? +v : NaN);
  const today = () => new Date().toISOString().slice(0, 10);
  const range = (q) => ({ country: q('country') || '', from: q('from') || today(), to: q('to') || today() });

  // route -> [roles allowed (null = public; admin always passes), handler(ctx) -> JSON-able result]
  const routes = {
    'GET /api/malls': [null, () => db.prepare('SELECT id,name,country FROM malls ORDER BY name').all()],
    'GET /api/prices': [null, () => db.prepare('SELECT country,item,amount FROM prices').all()],
    'GET /api/slots': [null, ({ q }) => booking.listSlots(db, int(q('mall')), q('day'))],
    'POST /api/book': [null, async ({ req, ip }) => {
      if (bookings.blocked(ip)) throw new Error('too many attempts');
      const b = await json(req);
      const out = booking.book(db, { ...b, slotId: int(b.slotId) });
      bookings.hit(ip);
      return out;
    }],
    'POST /api/cancel': [null, async ({ req }) => { booking.cancel(db, (await json(req)).code); return {}; }],
    'POST /api/checkin': [['host'], async ({ req }) => { const b = await json(req); return queue.checkIn(db, b.code, new Date(), mallById(db, int(b.mall)).id); }],
    'POST /api/walkin': [['host'], async ({ req }) => { const b = await json(req); return queue.addWalkIn(db, int(b.mall), b); }],
    'GET /api/queue': [['host'], ({ q }) => queue.getQueue(db, mallById(db, int(q('mall'))).id)],
    'GET /api/active': [['monitor', 'photographer', 'host', 'cashier'], ({ q }) => queue.active(db, mallById(db, int(q('mall'))).id)],
    'POST /api/next': [['host'], async ({ req }) => { const b = await json(req); return queue.serveNext(db, int(b.mall), { force: b.force === true }); }],
    'POST /api/photos': [['photographer'], async ({ req, q }) => {
      const mall = mallById(db, int(q('mall'))).id;
      const serving = queue.active(db, mall)?.code; // read BEFORE the slow body, so a shot can't land on the next family
      const bytes = await readBody(req, MAX_PHOTO);
      return await photos.ingest(db, dir, mall, q('name'), bytes, serving || 'none');
    }],
    'POST /api/cart': [['monitor', 'cashier'], async ({ req }) => { const b = await json(req); return orders.saveCart(db, b.code, b.items, b.files || []); }],
    'GET /api/order': [['monitor', 'cashier'], ({ q }) => orders.getOrder(db, q('code'))],
    'POST /api/pay': [['cashier'], async ({ req }) => { const b = await json(req); return orders.pay(db, b.code, b); }],
    'GET /api/print/next': [['printer'], ({ q }) => orders.nextPrintJob(db, mallById(db, int(q('mall'))).id)],
    'POST /api/print/done': [['printer'], async ({ req }) => { orders.markPrinted(db, (await json(req)).code); return {}; }],
    'GET /api/admin/files': [[], ({ q }) => orders.adminFiles(db, q('code'))],
    'PUT /api/admin/prices': [[], async ({ req }) => { const b = await json(req); admin.setPrice(db, b.country, b.item, b.amount); return {}; }],
    'POST /api/admin/malls': [[], async ({ req }) => { const b = await json(req); admin.addMall(db, b.name, b.country); return {}; }],
    'POST /api/admin/slots/bulk': [[], async ({ req }) => { const b = await json(req); return admin.addSlots(db, { ...b, mall: int(b.mall), minutes: int(b.minutes), capacity: int(b.capacity) }); }],
    'GET /api/admin/sales': [[], ({ q }) => admin.dailySales(db, int(q('mall')), q('day'))],
    'GET /api/admin/dashboard': [[], ({ q }) => stats.dashboard(db, range(q))],
  };

  return http.createServer(async (req, res) => {
    const send = (code, data, type = 'application/json', extra = {}) => {
      if (res.headersSent) return;
      res.writeHead(code, { ...HEADERS, 'content-type': type, 'cache-control': 'no-store', ...extra });
      res.end(Buffer.isBuffer(data) || typeof data === 'string' ? data : JSON.stringify(data));
    };
    try {
      const u = new URL(req.url, 'http://x'); // inside the try: a malformed URL must not crash the process
      const q = (k) => u.searchParams.get(k);
      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
      const pin = String(req.headers['x-pin'] || ''); // header only: a PIN in a URL ends up in logs and history
      const allowed = (need) => {
        if (need === null) return;
        if (badPins.blocked(ip)) throw new Error('too many attempts');
        const role = roleOf(pin);
        if (role && (role === 'admin' || need.includes(role))) return;
        badPins.hit(ip);
        throw new Error('pin');
      };
      const route = routes[`${req.method} ${u.pathname}`];
      if (route) { allowed(route[0]); return send(200, await route[1]({ req, q, ip })); }

      if (req.method === 'GET') {
        let m;
        if ((m = u.pathname.match(/^\/api\/qr\/([A-Z0-9]{8})$/))) {
          return send(200, await QRCode.toString(m[1], { type: 'svg', margin: 1 }), 'image/svg+xml', { 'cache-control': 'public, max-age=86400' });
        }
        if ((m = u.pathname.match(/^\/api\/gallery\/(\w{1,16})$/))) {
          allowed(['monitor', 'cashier', 'host', 'photographer']);
          const g = photos.gallery(db, m[1]);
          if (!g) throw new Error('unknown code');
          return send(200, g);
        }
        if (u.pathname === '/api/admin/export') {
          allowed([]);
          const o = range(q), type = q('type') === 'daily' ? 'daily' : 'orders';
          const data = type === 'daily' ? exp.dailyCsv(db, o) : exp.ordersCsv(db, o);
          return send(200, data, 'text/csv; charset=utf-8', { 'content-disposition': `attachment; filename="${type}_${o.country || 'all'}_${o.from}_${o.to}.csv"` });
        }
        // Pictures. Screens only ever get the watermarked preview. The clean original goes to the admin, and to the
        // printer once payment is confirmed. There is no public download.
        if ((m = u.pathname.match(/^\/preview\/(\w{1,16})\/([\w.-]{1,200})$/))) {
          allowed(['monitor', 'cashier', 'host']);
          return send(200, await photos.read(db, dir, m[1], m[2]), 'image/jpeg');
        }
        if ((m = u.pathname.match(/^\/photo\/(\w{1,16})\/([\w.-]{1,200})$/))) {
          allowed([]);
          return send(200, await photos.read(db, dir, m[1], m[2], { clean: true }), MIME[path.extname(m[2]).toLowerCase()], { 'content-disposition': `attachment; filename="${m[2]}"` });
        }
        if (u.pathname === '/api/print/file') {
          allowed(['printer']);
          const code = String(q('code') || ''), file = String(q('file') || '');
          if (!orders.paidFiles(db, code).includes(file)) throw new Error('not found');
          return send(200, await photos.read(db, dir, code, file, { clean: true }), MIME[path.extname(file).toLowerCase()]);
        }
        if (!u.pathname.startsWith('/api/')) {
          const f = path.resolve(PUBLIC, u.pathname === '/' ? 'book.html' : '.' + path.posix.normalize(u.pathname));
          const type = MIME[path.extname(f)];
          if (f.startsWith(PUBLIC + path.sep) && type && fs.existsSync(f) && fs.statSync(f).isFile()) {
            return send(200, await fs.promises.readFile(f), type, { 'cache-control': 'no-cache' });
          }
        }
      }
      throw new Error('not found');
    } catch (e) {
      const status = KNOWN[e.message];
      if (status) return send(status, { error: e.message });
      log(`${req.method} ${req.url}:`, e); // unexpected: keep the detail in the server log, not in the response
      send(500, { error: 'server error' });
    }
  });
}

module.exports = { createServer, limiter };
