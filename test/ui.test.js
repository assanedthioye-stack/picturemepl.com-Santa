const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { openDb } = require('../server/db');
const { createServer } = require('../server/index');

const PINS = { host: 'h1', photographer: 'p1', cashier: 'c1', monitor: 'm1', admin: 'a1' };

test('family books, host checks in, photo, monitor picks Famille, cashier takes cash, print job appears', async () => {
  const db = openDb();
  db.prepare("INSERT INTO malls(id,name,country) VALUES(1,'Sea Plaza','SN')").run();
  db.prepare('INSERT INTO slots(id,mall_id,start_at,capacity) VALUES(1,1,?,3)').run(new Date().toISOString());
  const srv = createServer({ db, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'pmp-')), pins: PINS });
  await new Promise((r) => srv.listen(0, r));
  const base = 'http://localhost:' + srv.address().port;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const open = async (url, pin) => {
    const p = await ctx.newPage();
    p.on('dialog', (d) => d.accept(pin));
    await p.goto(base + url);
    return p;
  };
  try {
    const book = await open('/book.html');
    await book.locator('#slots button').first().click();
    await book.fill('#name', 'Awa'); await book.fill('#phone', '+221700000000'); await book.check('#consent');
    await book.click('#go');
    await book.waitForSelector('#code:not(:empty)');
    const code = await book.textContent('#code');
    if (process.env.SHOTS) await book.screenshot({ path: process.env.SHOTS + '/book.png' });

    const host = await open('/host.html?mall=1', 'h1');
    await host.fill('#code', code); await host.click('#ci');
    await host.waitForSelector('#msg.good');
    await host.click('#next');
    await host.waitForSelector('.q.serving');

    const up = await fetch(base + '/api/photos?mall=1&name=a.jpg', { method: 'POST', headers: { 'x-pin': 'p1' }, body: 'JPEG' });
    assert.equal(up.status, 200);

    const mon = await open('/monitor.html?mall=1', 'm1');
    await mon.waitForSelector('.thumbs img');
    await mon.locator('.thumbs img').first().click();
    await mon.locator('#pk .item').nth(1).locator('button').last().click(); // Famille +
    await mon.waitForFunction(() => document.querySelector('#tot').textContent.includes('Total'));
    if (process.env.SHOTS) await mon.screenshot({ path: process.env.SHOTS + '/monitor.png' });

    const cash = await open('/cashier.html?mall=1', 'c1');
    await cash.waitForSelector('#o:not([hidden])');
    await cash.fill('#recv', '10000');
    await cash.click('#pay');
    await cash.waitForFunction(() => document.querySelector('#msg').textContent.includes('✓'));

    const job = await (await fetch(base + '/api/print/next?mall=1', { headers: { 'x-pin': 'c1' } })).json();
    assert.equal(job.code, code);
  } finally { await browser.close(); srv.close(); }
});

test('a parent name with HTML is shown as text on the host screen', async () => {
  const db = openDb();
  db.prepare("INSERT INTO malls(id,name,country) VALUES(1,'M','SN')").run();
  db.prepare('INSERT INTO slots(id,mall_id,start_at,capacity) VALUES(1,1,?,3)').run(new Date().toISOString());
  const srv = createServer({ db, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'pmp-')), pins: PINS });
  await new Promise((r) => srv.listen(0, r));
  const base = 'http://localhost:' + srv.address().port;
  const post = (u, b, pin) => fetch(base + u, { method: 'POST', headers: { 'x-pin': pin || '' }, body: JSON.stringify(b) }).then((r) => r.json());
  const { code } = await post('/api/book', { slotId: 1, name: '<img src=x onerror="window.__xss=1">', phone: '1', consent: true });
  await post('/api/checkin', { code }, 'h1');
  const browser = await chromium.launch();
  try {
    const p = await browser.newPage();
    p.on('dialog', (d) => d.accept('h1'));
    await p.goto(base + '/host.html?mall=1');
    await p.waitForSelector('.q');
    assert.equal(await p.evaluate(() => window.__xss), undefined);
    assert.ok((await p.textContent('.q')).includes('<img'));
  } finally { await browser.close(); srv.close(); }
});

test('dashboard page shows KPIs from seeded sales', async () => {
  const { addWalkIn, serveNext } = require('../server/queue');
  const { saveCart, pay } = require('../server/orders');
  const db = openDb();
  db.prepare("INSERT INTO malls(id,name,country) VALUES(1,'Sea Plaza','SN')").run();
  const code = addWalkIn(db, 1, { name: 'A', phone: '1', consent: true }).code;
  serveNext(db, 1);
  saveCart(db, code, [{ item: 'famille', qty: 1 }], []);
  pay(db, code, { method: 'cash', amountReceived: 10000, expectedTotal: 10000, cashier: 'amy' });
  const srv = createServer({ db, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'pmp-')), pins: PINS });
  await new Promise((r) => srv.listen(0, r));
  const browser = await chromium.launch();
  try {
    const p = await browser.newPage({ viewport: { width: 390, height: 1200 } });
    p.on('dialog', (d) => d.accept('a1'));
    await p.goto('http://localhost:' + srv.address().port + '/dashboard.html');
    await p.waitForSelector('.tile');
    const text = await p.textContent('#tiles');
    assert.ok(/10\s?000/.test(text.replace(/ | /g, ' ')), text);
    if (process.env.SHOTS) await p.screenshot({ path: process.env.SHOTS + '/dashboard.png', fullPage: true });
  } finally { await browser.close(); srv.close(); }
});

test('dashboard draws trend charts and downloads the orders CSV', async () => {
  const { seed } = require('./seed');
  const db = seed();
  const srv = createServer({ db, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'pmp-')), pins: PINS });
  await new Promise((r) => srv.listen(0, r));
  const browser = await chromium.launch();
  try {
    const p = await browser.newPage({ viewport: { width: 390, height: 1200 }, acceptDownloads: true });
    p.on('dialog', (d) => d.accept('a1'));
    await p.goto('http://localhost:' + srv.address().port + '/dashboard.html');
    await p.fill('#from', '2026-12-18'); await p.fill('#to', '2026-12-22'); await p.dispatchEvent('#to', 'change');
    await p.waitForSelector('#trend svg polyline');
    assert.equal(await p.locator('#activity polyline').count(), 3);
    assert.equal(await p.locator('#peak rect').count(), 24);
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#x1')]);
    assert.match(dl.suggestedFilename(), /^orders_SN_2026-12-18_2026-12-22\.csv$/);
    const body = fs.readFileSync(await dl.path(), 'utf8');
    assert.ok(body.includes('12800;cash'));
    if (process.env.SHOTS) await p.screenshot({ path: process.env.SHOTS + '/dashboard2.png', fullPage: true });
  } finally { await browser.close(); srv.close(); }
});

test('admin creates a whole day of slots from one simple form, and families can then book', async () => {
  const db = openDb();
  db.prepare("INSERT INTO malls(id,name,country) VALUES(1,'Francoise Garden','SN')").run();
  const srv = createServer({ db, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'pmp-')), pins: PINS });
  await new Promise((r) => srv.listen(0, r));
  const base = 'http://localhost:' + srv.address().port;
  const browser = await chromium.launch();
  try {
    const p = await browser.newPage({ viewport: { width: 390, height: 1100 } });
    p.on('dialog', (d) => d.accept('a1'));
    await p.goto(base + '/admin.html');
    await p.selectOption('#mallsel', '1');
    const day = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await p.fill('#from', day); await p.fill('#to', day);
    await p.fill('#open', '10:00'); await p.fill('#close', '12:00'); await p.fill('#len', '30');
    await p.click('#mk');
    await p.waitForFunction(() => document.querySelector('#smsg').textContent.includes('4'));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM slots').get().n, 4);
    const b = await browser.newPage();
    await b.goto(base + '/book.html');
    await b.fill('#day', day); await b.dispatchEvent('#day', 'change');
    await b.waitForSelector('#slots button');
    assert.equal(await b.locator('#slots button').count(), 4);
  } finally { await browser.close(); srv.close(); }
});

test('admin shows the price list pre-filled for the mall country; editing a price saves on change', async () => {
  const db = openDb();
  db.prepare("INSERT INTO malls(id,name,country) VALUES(1,'Cotonou','BJ'),(2,'Dakar','SN')").run();
  const srv = createServer({ db, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'pmp-')), pins: PINS });
  await new Promise((r) => srv.listen(0, r));
  const browser = await chromium.launch();
  try {
    const p = await browser.newPage({ viewport: { width: 390, height: 1100 } });
    p.on('dialog', (d) => d.accept('a1'));
    await p.goto('http://localhost:' + srv.address().port + '/admin.html');
    await p.selectOption('#mallsel', '1');
    await p.click('#priceBox summary');
    await p.waitForFunction(() => document.querySelector('input[data-item="famille"]')?.value === '8500'); // Benin, from the official sheet
    await p.selectOption('#mallsel', '2');
    await p.waitForFunction(() => document.querySelector('input[data-item="famille"]')?.value === '10000'); // Senegal
    await p.fill('input[data-item="famille"]', '11000');
    await p.dispatchEvent('input[data-item="famille"]', 'change');
    await p.waitForFunction(() => document.querySelector('#pmsg').textContent.includes('✓'));
    assert.equal(db.prepare("SELECT amount a FROM prices WHERE country='SN' AND item='famille'").get().a, 11000);
    assert.equal(db.prepare("SELECT amount a FROM prices WHERE country='BJ' AND item='famille'").get().a, 8500);
  } finally { await browser.close(); srv.close(); }
});
