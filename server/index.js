const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./db');
const booking = require('./booking');
const queue = require('./queue');
const photos = require('./photos');
const orders = require('./orders');
const admin = require('./admin');
const stats = require('./stats');
const exp = require('./export');
const QRCode = require('qrcode');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.json': 'application/json' };
const STATUS = { 'unpaid order': 409, 'total changed': 409, 'no active family': 409, full: 409, 'already paid': 409, 'unknown code': 404, 'unknown slot': 404 };

function createServer({ db, dir, pins }) {
  const roleOf = (pin) => Object.keys(pins).find((r) => pins[r] === pin);
  const ok = (pin, roles) => { const r = roleOf(pin); return r && (r === 'admin' || roles.includes(r)); };

  async function body(req, raw) {
    const chunks = [];
    let n = 0;
    for await (const c of req) { n += c.length; if (n > 25e6) throw new Error('too large'); chunks.push(c); }
    const buf = Buffer.concat(chunks);
    return raw ? buf : buf.length ? JSON.parse(buf) : {};
  }

  return http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, data, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type });
      res.end(Buffer.isBuffer(data) || typeof data === 'string' ? data : JSON.stringify(data));
    };
    const pin = req.headers['x-pin'] || u.searchParams.get('pin') || '';
    const q = (k) => u.searchParams.get(k);
    const route = `${req.method} ${u.pathname}`;
    try {
      // role-protected API
      const need = {
        'POST /api/checkin': ['host'], 'POST /api/walkin': ['host'], 'GET /api/queue': ['host'], 'POST /api/next': ['host'],
        'POST /api/photos': ['photographer'], 'POST /api/cart': ['monitor', 'cashier'], 'POST /api/pay': ['cashier'],
        'GET /api/order': ['cashier', 'monitor'], 'GET /api/print/next': ['cashier'], 'POST /api/print/done': ['cashier'], 'GET /api/active': ['monitor', 'photographer', 'host', 'cashier'],
        'PUT /api/admin/prices': [], 'POST /api/admin/slots': [], 'POST /api/admin/malls': [], 'GET /api/admin/sales': [], 'GET /api/admin/dashboard': [], 'GET /api/admin/export': [],
      }[route];
      const gal = u.pathname.match(/^\/api\/gallery\/(\w+)$/);
      const ph = u.pathname.match(/^\/photo\/(\w+)\/([\w.-]+)$/);
      const dl = u.pathname.match(/^\/dl\/(\w+)\/([\w.-]+)$/);
      if (gal || ph) { if (!ok(pin, ['monitor', 'cashier', 'host'])) return send(401, { error: 'pin' }); }
      else if (need && !ok(pin, need)) return send(401, { error: 'pin' });

      const qr = u.pathname.match(/^\/api\/qr\/(\w+)$/);
      if (qr) return send(200, await QRCode.toString(qr[1], { type: 'svg', margin: 1 }), 'image/svg+xml');
      if (route === 'GET /api/malls') return send(200, db.prepare('SELECT id,name,country FROM malls').all());
      if (route === 'GET /api/slots') return send(200, booking.listSlots(db, +q('mall'), q('day')));
      if (route === 'POST /api/book') return send(200, booking.book(db, await body(req)));
      if (route === 'POST /api/cancel') { booking.cancel(db, (await body(req)).code); return send(200, {}); }
      if (route === 'POST /api/checkin') return send(200, queue.checkIn(db, (await body(req)).code));
      if (route === 'POST /api/walkin') { const b = await body(req); return send(200, queue.addWalkIn(db, +b.mall, b)); }
      if (route === 'GET /api/queue') return send(200, queue.getQueue(db, +q('mall')));
      if (route === 'GET /api/active') {
        return send(200, db.prepare("SELECT code,name FROM queue WHERE mall_id=? AND state='serving'").get(+q('mall')) || null);
      }
      if (route === 'POST /api/next') { const b = await body(req); return send(200, queue.serveNext(db, +b.mall, { force: !!b.force })); }
      if (route === 'POST /api/photos') {
        const serving = db.prepare("SELECT code FROM queue WHERE mall_id=? AND state='serving'").get(+q('mall'))?.code; // read BEFORE the slow body
        return send(200, photos.ingest(db, dir, +q('mall'), q('name'), await body(req, true), serving || 'none'));
      }
      if (gal) { const g = photos.gallery(db, gal[1]); return g ? send(200, g) : send(404, { error: 'not found' }); }
      if (route === 'POST /api/cart') { const b = await body(req); return send(200, orders.saveCart(db, b.code, b.items, b.files || [])); }
      if (route === 'POST /api/pay') { const b = await body(req); return send(200, orders.pay(db, b.code, { ...b, amountReceived: b.amountReceived, cashier: b.cashier || 'cashier' })); }
      if (route === 'GET /api/print/next') return send(200, orders.nextPrintJob(db, +q('mall')));
      if (route === 'POST /api/print/done') { orders.markPrinted(db, (await body(req)).code); return send(200, {}); }
      if (ph || dl) {
        const [, code, file] = ph || dl;
        if (dl && !(orders.download(db, code) || []).includes(file)) return send(404, { error: 'not found' });
        const f = path.join(dir, code, file);
        return fs.existsSync(f) ? send(200, fs.readFileSync(f), MIME[path.extname(file)] || 'application/octet-stream') : send(404, { error: 'not found' });
      }
      if (route === 'PUT /api/admin/prices') { const b = await body(req); admin.setPrice(db, b.country, b.item, b.amount); return send(200, {}); }
      if (route === 'POST /api/admin/malls') { const b = await body(req); admin.addMall(db, b.name, b.country); return send(200, {}); }
      if (route === 'POST /api/admin/slots') { const b = await body(req); admin.addSlot(db, +b.mall, b.startAt, +b.capacity); return send(200, {}); }
      if (route === 'GET /api/admin/dashboard') { const today = new Date().toISOString().slice(0, 10); return send(200, stats.dashboard(db, { country: q('country') || '', from: q('from') || today, to: q('to') || today })); }
      if (route === 'GET /api/admin/export') {
        const today = new Date().toISOString().slice(0, 10);
        const o = { country: q('country') || '', from: q('from') || today, to: q('to') || today };
        const type = q('type') === 'daily' ? 'daily' : 'orders';
        const data = type === 'daily' ? exp.dailyCsv(db, o) : exp.ordersCsv(db, o);
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${type}_${o.country || 'all'}_${o.from}_${o.to}.csv"` });
        return res.end(data);
      }
      if (route === 'GET /api/admin/sales') return send(200, admin.dailySales(db, +q('mall'), q('day')));
      if (route === 'GET /api/order') {
        const o = db.prepare('SELECT lines_json,total,paid_at,method,provider,print_state FROM orders WHERE code=?').get(q('code'));
        const c = db.prepare('SELECT m.country FROM queue q JOIN malls m ON m.id=q.mall_id WHERE q.code=?').get(q('code'));
        return o && c ? send(200, { lines: JSON.parse(o.lines_json), total: o.total, paid: !!o.paid_at, method: o.method, provider: o.provider, print_state: o.print_state, country: c.country, downloads: o.paid_at ? orders.download(db, q('code')) : null }) : send(404, { error: 'unknown code' });
      }
      if (route === 'GET /api/prices') return send(200, db.prepare('SELECT country,item,amount FROM prices').all());

      // static pages
      if (req.method === 'GET' && !u.pathname.startsWith('/api')) {
        const rel = u.pathname === '/' ? 'book.html' : u.pathname.slice(1);
        const f = path.resolve(__dirname, '..', 'public', rel);
        if (f.startsWith(path.resolve(__dirname, '..', 'public') + path.sep) && fs.existsSync(f))
          return send(200, fs.readFileSync(f), MIME[path.extname(f)] || 'application/octet-stream');
      }
      send(404, { error: 'not found' });
    } catch (e) {
      send(STATUS[e.message] || 400, { error: e.message });
    }
  });
}

module.exports = { createServer };
