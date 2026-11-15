const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const sharp = require('sharp');
const { openDb } = require('../server/db');
const jpeg = () => sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#808080' } }).jpeg().toBuffer();
const { createServer } = require('../server/app');

const PINS = { host: 'h111', photographer: 'p111', cashier: 'c111', monitor: 'm111', admin: 'a111' };

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

    const host = await open('/host.html?mall=1', 'h111');
    await host.fill('#staff', 'Fatou'); await host.fill('#code', code); await host.click('#ci');
    await host.waitForSelector('#msg.good');
    await host.click('#next');
    await host.waitForSelector('.q.serving');

    const up = await fetch(base + '/api/photos?mall=1&name=a.jpg', { method: 'POST', headers: { 'x-pin': 'p111' }, body: await jpeg() });
    assert.equal(up.status, 200);

    const mon = await open('/monitor.html?mall=1', 'm111');
    await mon.waitForSelector('.thumbs img');
    await mon.locator('.thumbs img').first().click();
    await mon.locator('#pk .item').nth(1).locator('button').last().click(); // Famille +
    await mon.waitForFunction(() => document.querySelector('#tot').textContent.includes('Total'));
    if (process.env.SHOTS) await mon.screenshot({ path: process.env.SHOTS + '/monitor.png' });

    const cash = await open('/cashier.html?mall=1', 'c111');
    await cash.waitForSelector('#o:not([hidden])');
    await cash.fill('#who', 'Amy'); await cash.fill('#recv', '10000');
    await cash.click('#pay');
    await cash.waitForFunction(() => document.querySelector('#msg').textContent.includes('✓'));

    assert.equal(await mon.locator('a[href^="/dl"], a[download]').count(), 0); // nothing to download on the customer screen
    const job = await (await fetch(base + '/api/print/next?mall=1', { headers: { 'x-pin': 'a111' } })).json();
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
  const { code } = await post('/api/book', { slotId: 1, name: '<img src=x onerror="window.__xss=1">', phone: '+221700000000', consent: true });
  await post('/api/checkin', { code, mall: 1 }, 'h111');
  const browser = await chromium.launch();
  try {
    const p = await browser.newPage();
    p.on('dialog', (d) => d.accept('h111'));
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
  const code = addWalkIn(db, 1, { name: 'A', phone: '+221700000000', consent: true }).code;
  serveNext(db, 1);
  db.prepare("INSERT INTO photos(code,file) VALUES(?,'1_a.jpg')").run(code);
  saveCart(db, code, [{ item: 'famille', qty: 1 }], ['1_a.jpg']);
  pay(db, code, { method: 'cash', amountReceived: 10000, expectedTotal: 10000, cashier: 'amy' });
  const srv = createServer({ db, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'pmp-')), pins: PINS });
  await new Promise((r) => srv.listen(0, r));
  const browser = await chromium.launch();
  try {
    const p = await browser.newPage({ viewport: { width: 390, height: 1200 } });
    p.on('dialog', (d) => d.accept('a111'));
    await p.goto('http://localhost:' + srv.address().port + '/dashboard.html');
    await p.waitForSelector('.tile');
    const text = await p.textContent('#tiles');
    assert.ok(/10\s?000/.test(text.replace(/\s/g, ' ')), text);
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
    p.on('dialog', (d) => d.accept('a111'));
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
    p.on('dialog', (d) => d.accept('a111'));
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
    p.on('dialog', (d) => d.accept('a111'));
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

test('with several malls a staff page asks which mall once, then remembers it', async () => {
  const db = openDb();
  db.prepare("INSERT INTO malls(id,name,country) VALUES(1,'Dakar','SN'),(2,'Cotonou','BJ')").run();
  const { addWalkIn } = require('../server/queue');
  addWalkIn(db, 2, { name: 'Benin family', phone: '', consent: true });
  const srv = createServer({ db, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'pmp-')), pins: PINS });
  await new Promise((r) => srv.listen(0, r));
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    p.on('dialog', (d) => d.accept('h111'));
    await p.goto('http://localhost:' + srv.address().port + '/host.html');
    await p.click('button[data-mall="2"]');
    await p.waitForSelector('.q');
    assert.ok((await p.textContent('#q')).includes('Benin family'));
    await p.reload();
    await p.waitForSelector('.q'); // remembered: no picker this time
    assert.equal(await p.locator('button[data-mall]').count(), 0);
  } finally { await browser.close(); srv.close(); }
});

test('after a paid digital sale the cashier shows a QR; the family page downloads the clean photo', async () => {
  const { addWalkIn, serveNext } = require('../server/queue');
  const { saveCart } = require('../server/orders');
  const db = openDb();
  db.prepare("INSERT INTO malls(id,name,country) VALUES(1,'Dakar','SN')").run();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmp-'));
  const srv = createServer({ db, dir, pins: PINS });
  await new Promise((r) => srv.listen(0, r));
  const base = 'http://localhost:' + srv.address().port;
  const code = addWalkIn(db, 1, { name: 'A', phone: '', consent: true }).code;
  serveNext(db, 1);
  const original = await jpeg();
  const up = await (await fetch(base + '/api/photos?mall=1&name=a.jpg', { method: 'POST', headers: { 'x-pin': 'p111' }, body: original })).json();
  saveCart(db, code, [{ item: 'numerique', qty: 1 }], [up.file]);
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ acceptDownloads: true });
    const cash = await ctx.newPage();
    cash.on('dialog', (d) => d.accept('c111'));
    await cash.goto(base + '/cashier.html');
    await cash.waitForSelector('#o:not([hidden])');
    assert.equal(await cash.isVisible('#deliv'), false); // nothing to hand over before payment
    await cash.fill('#who', 'Amy'); await cash.fill('#recv', '5000'); await cash.click('#pay');
    await cash.waitForSelector('#deliv:not([hidden])');
    const url = await cash.textContent('#durl');
    assert.equal(await cash.locator('a[download]').count(), 0); // the cashier screen itself offers no download
    const fam = await browser.newPage(); // the family's phone: no PIN at all
    await fam.goto(url);
    const [dl] = await Promise.all([fam.waitForEvent('download'), fam.click('a[download]')]);
    assert.ok(fs.readFileSync(await dl.path()).equals(original));
  } finally { await browser.close(); srv.close(); }
});

test('dashboard shows the team: who is on duty and what each host, photographer and cashier did', async () => {
  const { addWalkIn, serveNext, setPresence } = require('../server/queue');
  const { saveCart, pay } = require('../server/orders');
  const db = openDb();
  db.prepare("INSERT INTO malls(id,name,country) VALUES(1,'Dakar','SN')").run();
  const code = addWalkIn(db, 1, { name: 'A', phone: '', consent: true, staff: 'Fatou' }).code;
  setPresence(db, 1, 'photographer', 'Awa');
  serveNext(db, 1, { staff: 'Fatou' });
  db.prepare("INSERT INTO photos(code,file,photographer) VALUES(?,'1_a.jpg','Awa')").run(code);
  saveCart(db, code, [{ item: 'famille', qty: 1 }], ['1_a.jpg']);
  pay(db, code, { method: 'cash', amountReceived: 10000, expectedTotal: 10000, cashier: 'Amy' });
  const srv = createServer({ db, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'pmp-')), pins: PINS });
  await new Promise((r) => srv.listen(0, r));
  const browser = await chromium.launch();
  try {
    const p = await browser.newPage({ viewport: { width: 390, height: 1200 } });
    p.on('dialog', (d) => d.accept('a111'));
    await p.goto('http://localhost:' + srv.address().port + '/dashboard.html');
    await p.waitForSelector('#thost td');
    for (const [sel, name] of [['#thost', 'Fatou'], ['#tphoto', 'Awa'], ['#tcash', 'Amy']]) assert.ok((await p.textContent(sel)).includes(name), sel);
    const duty = await p.textContent('#duty');
    assert.ok(duty.includes('Fatou') && duty.includes('Awa') && duty.includes('Amy'));
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true); // no sideways scroll on a phone
    if (process.env.SHOTS) await p.locator('#duty').locator('xpath=..').screenshot({ path: process.env.SHOTS + '/team.png' });
  } finally { await browser.close(); srv.close(); }
});
