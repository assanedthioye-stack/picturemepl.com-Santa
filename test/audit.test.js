// Regressions for the November 2026 audit. Each test failed before its fix.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../server/db');
const { serve } = require('./serve');
const { addWalkIn, serveNext } = require('../server/queue');
const { saveCart, pay } = require('../server/orders');

const PINS = { host: 'h111', photographer: 'p111', cashier: 'c111', monitor: 'm111', admin: 'a111' };
const P = { name: 'Awa', phone: '+221700000000', consent: true };
function db2() {
  const db = openDb();
  db.prepare("INSERT INTO malls(id,name,country) VALUES(1,'Dakar','SN')").run();
  return db;
}
async function boot() {
  const errors = [];
  const db = db2();
  const srv = serve({ db, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'pmp-')), pins: PINS, log: (...a) => errors.push(a) });
  await new Promise((r) => srv.listen(0, r));
  const base = 'http://localhost:' + srv.address().port;
  const call = async (method, url, body, pin, headers = {}) => {
    const res = await fetch(base + url, { method, headers: { 'x-pin': pin || '', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return { srv, call, errors, db };
}
// A paid-ready family: walk-in, served, one photo, cart saved.
function family(db, items = [{ item: 'numerique', qty: 1 }]) {
  const code = addWalkIn(db, 1, P).code;
  serveNext(db, 1, { force: true });
  db.prepare("INSERT INTO photos(code,file) VALUES(?,'p.jpg')").run(code);
  return { code, total: saveCart(db, code, items, ['p.jpg']).total };
}

test('a forged X-Forwarded-For cannot dodge the PIN lockout', async () => {
  const { srv, call } = await boot();
  // A client picks any address it likes for the first X-Forwarded-For entry; the proxy appends the real one last.
  for (let i = 0; i < 20; i++) {
    assert.equal((await call('GET', '/api/queue?mall=1', null, 'x' + i, { 'x-forwarded-for': `10.9.${i}.1, 203.0.113.7` })).status, 401);
  }
  assert.equal((await call('GET', '/api/queue?mall=1', null, 'x', { 'x-forwarded-for': '10.200.0.1, 203.0.113.7' })).status, 429);
  // Another real client behind the same proxy is not affected.
  assert.equal((await call('GET', '/api/queue?mall=1', null, 'h111', { 'x-forwarded-for': '198.51.100.9' })).status, 200);
  srv.close();
});

test('an oversized cart is refused as a bad item, not a server error', async () => {
  const { srv, call, errors } = await boot();
  const r = await call('POST', '/api/cart', { code: 'NOPE2345', items: Array(21).fill({ item: 'numerique', qty: 1 }) }, 'c111');
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'bad item');
  assert.deepEqual(errors, []);
  srv.close();
});

test('a Mobile Money reference can pay only one order', () => {
  const db = db2();
  const a = family(db), b = family(db);
  const momo = (total) => ({ method: 'mobile_money', provider: 'Wave', reference: 'WV-12345', expectedTotal: total, cashier: 'Amy' });
  assert.equal(pay(db, a.code, momo(a.total)).total, 5000);
  assert.throws(() => pay(db, b.code, momo(b.total)), /reference used/);
  assert.throws(() => pay(db, b.code, { ...momo(b.total), reference: ' wv-12345 ' }), /reference used/); // same receipt, retyped
  assert.equal(pay(db, b.code, { ...momo(b.total), provider: 'Orange Money' }).total, 5000); // another operator's numbering
});

test('paying a second order with a used reference answers 409 through the API', async () => {
  const { srv, call, db } = await boot();
  const a = family(db), b = family(db);
  const body = (f) => ({ code: f.code, method: 'mobile_money', provider: 'Wave', reference: 'WV-777', expectedTotal: f.total });
  assert.equal((await call('POST', '/api/pay', body(a), 'c111')).status, 200);
  const r = await call('POST', '/api/pay', body(b), 'c111');
  assert.deepEqual([r.status, r.json.error], [409, 'reference used']);
  srv.close();
});

test('the print agent never drops an order into the printer twice when marking it printed fails', async () => {
  const http = require('node:http');
  const { spawn } = require('node:child_process');
  const hot = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-'));
  let fileFetches = 0, doneCalls = 0, printed = false;
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/api/print/next')) return res.end(JSON.stringify(printed ? null : { code: 'ABCD2345', files: ['1_a.jpg'], lines: [] }));
    if (req.url.startsWith('/api/print/file')) { fileFetches++; return res.end('jpegbytes'); }
    if (req.url === '/api/print/done') { doneCalls++; if (doneCalls === 1) { res.statusCode = 500; return res.end('{}'); } printed = true; return res.end('{}'); }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => srv.listen(0, r));
  const agent = spawn(process.execPath, [path.join(__dirname, '..', 'tools', 'print-agent.js'), `http://localhost:${srv.address().port}`, 'pin', '1', hot], { stdio: 'ignore' });
  for (let i = 0; i < 100 && !printed; i++) await new Promise((r) => setTimeout(r, 100));
  agent.kill(); srv.close();
  assert.ok(printed, 'the order was finally marked printed');
  assert.equal(doneCalls, 2);
  assert.equal(fileFetches, 1); // the retry only re-marked the order
  assert.ok(fs.existsSync(path.join(hot, 'ABCD2345', '1_a.jpg')));
});
