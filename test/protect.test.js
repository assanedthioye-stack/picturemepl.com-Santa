const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { openDb } = require('../server/db');
const { createServer } = require('../server/app');
const { addWalkIn, serveNext } = require('../server/queue');
const { saveCart, pay } = require('../server/orders');
const { makePreview } = require('../server/photos');

const PINS = { host: 'h111', photographer: 'p111', cashier: 'c111', monitor: 'm111', admin: 'a111', printer: 'r111' };
const jpeg = (w = 3000, h = 2000) => sharp({ create: { width: w, height: h, channels: 3, background: '#808080' } }).jpeg().toBuffer();

async function boot() {
  const db = openDb();
  db.prepare("INSERT INTO malls(id,name,country) VALUES(1,'Dakar','SN')").run();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmp-'));
  const srv = createServer({ db, dir, pins: PINS });
  await new Promise((r) => srv.listen(0, r));
  const base = 'http://localhost:' + srv.address().port;
  const get = async (url, pin) => { const r = await fetch(base + url, { headers: { 'x-pin': pin || '' } }); return { status: r.status, type: r.headers.get('content-type'), buf: Buffer.from(await r.arrayBuffer()) }; };
  const code = addWalkIn(db, 1, { name: 'A', phone: '', consent: true }).code;
  serveNext(db, 1);
  const original = await jpeg();
  const up = await (await fetch(base + '/api/photos?mall=1&name=a.jpg', { method: 'POST', headers: { 'x-pin': 'p111' }, body: original })).json();
  return { db, dir, srv, get, code, file: up.file, original };
}
const payFor = (db, code, file) => { saveCart(db, code, [{ item: 'famille', qty: 1 }], [file]); pay(db, code, { method: 'cash', amountReceived: 10000, expectedTotal: 10000, cashier: 'amy' }); };

test('the preview is small and visibly watermarked across the picture', async () => {
  const pv = await makePreview(await jpeg());
  const meta = await sharp(pv).metadata();
  assert.ok(meta.width <= 1000 && meta.height <= 1000);
  const { data } = await sharp(pv).greyscale().raw().toBuffer({ resolveWithObject: true });
  // The source is flat grey: any pixel far from grey is watermark. It must cover every quarter of the image.
  const w = meta.width, h = meta.height;
  for (const [x0, y0] of [[0, 0], [w / 2, 0], [0, h / 2], [w / 2, h / 2]]) {
    let marked = 0;
    for (let y = Math.floor(y0); y < y0 + h / 2; y++) for (let x = Math.floor(x0); x < x0 + w / 2; x++) if (Math.abs(data[y * w + x] - 128) > 25) marked++;
    assert.ok(marked > 500, `quarter at ${x0},${y0} has only ${marked} watermark pixels`);
  }
});
test('screens get the watermarked preview; the original is admin-only', async () => {
  const { srv, get, code, file, original } = await boot();
  for (const pin of ['m111', 'c111', 'h111']) {
    const pv = await get(`/preview/${code}/${file}`, pin);
    assert.equal(pv.status, 200);
    assert.ok(!pv.buf.equals(original));
    assert.equal((await sharp(pv.buf).metadata()).width, 1000);
    assert.equal((await get(`/photo/${code}/${file}`, pin)).status, 401); // no original for staff
  }
  assert.equal((await get(`/preview/${code}/${file}`)).status, 401);
  assert.equal((await get(`/photo/${code}/${file}`, 'p111')).status, 401);
  assert.ok((await get(`/photo/${code}/${file}`, 'a111')).buf.equals(original));
  srv.close();
});
test('there is no public download link, paid or not', async () => {
  const { db, srv, get, code, file } = await boot();
  assert.equal((await get(`/dl/${code}/${file}`)).status, 404);
  payFor(db, code, file);
  assert.equal((await get(`/dl/${code}/${file}`)).status, 404);
  assert.equal((await get(`/dl/${code}/${file}`, 'c111')).status, 404);
  srv.close();
});
test('the clean file is released to the printer only after confirmed payment, and only the chosen photos', async () => {
  const { db, srv, get, code, file, original } = await boot();
  const url = `/api/print/file?code=${code}&file=${file}`;
  saveCart(db, code, [{ item: 'famille', qty: 1 }], [file]);
  assert.equal((await get(url, 'r111')).status, 404); // cart exists but not paid
  payFor(db, code, file);
  assert.equal((await get(url, 'c111')).status, 401); // cashier cannot fetch clean files
  assert.equal((await get(url, 'm111')).status, 401);
  assert.equal((await get(url)).status, 401);
  assert.ok((await get(url, 'r111')).buf.equals(original));
  assert.ok((await get(url, 'a111')).buf.equals(original));
  assert.equal((await get(`/api/print/file?code=${code}&file=other.jpg`, 'r111')).status, 404);
  assert.equal((await get('/api/print/next?mall=1', 'c111')).status, 401);
  assert.equal((await get('/api/print/next?mall=1', 'r111')).status, 200);
  srv.close();
});
test('a file that is not really an image is refused at upload', async () => {
  const { srv } = await boot();
  const r = await fetch('http://localhost:' + srv.address().port + '/api/photos?mall=1&name=fake.jpg', { method: 'POST', headers: { 'x-pin': 'p111' }, body: 'not an image' });
  assert.equal((await r.json()).error, 'bad file');
  srv.close();
});
test('the preview file on disk is never listed as a family photo, and admin can list a family\'s files', async () => {
  const { db, srv, get, code, file, dir } = await boot();
  assert.ok(fs.existsSync(path.join(dir, code, 'pv_' + file + '.jpg')));
  assert.deepEqual(JSON.parse((await get('/api/gallery/' + code, 'm111')).buf), [file]);
  assert.equal((await get('/api/admin/files?code=' + code, 'c111')).status, 401);
  payFor(db, code, file);
  assert.deepEqual(JSON.parse((await get('/api/admin/files?code=' + code, 'a111')).buf), { files: [file], chosen: [file], paid: true, digital: true });
  srv.close();
});
