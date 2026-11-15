const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { openDb } = require('../server/db');
const { addWalkIn, serveNext } = require('../server/queue');
const { ingest, gallery } = require('../server/photos');

function setup() {
  const db = openDb();
  db.prepare("INSERT INTO malls(id,name,country) VALUES(1,'M','SN')").run();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmp-'));
  return { db, dir };
}
let IMG;
test.before(async () => { IMG = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#808080' } }).jpeg().toBuffer(); });
const walk = (db, n) => addWalkIn(db, 1, { name: n, phone: '+221700000000', consent: true }).code;

test('ingest stores and lists for the serving family', async () => {
  const { db, dir } = setup();
  const c = walk(db, 'A');
  serveNext(db, 1);
  const r = await ingest(db, dir, 1, 'IMG_1.jpg', IMG);
  assert.equal(r.code, c);
  assert.equal(gallery(db, c).length, 1);
  assert.ok(fs.existsSync(path.join(dir, c, gallery(db, c)[0])));
});
test('no active family throws', async () => {
  const { db, dir } = setup();
  await assert.rejects(() => ingest(db, dir, 1, 'a.jpg', IMG), /no active family/);
});
test('next family gets only new shots', async () => {
  const { db, dir } = setup();
  const a = walk(db, 'A'), b = walk(db, 'B');
  serveNext(db, 1); await ingest(db, dir, 1, 'a.jpg', IMG);
  serveNext(db, 1); await ingest(db, dir, 1, 'b.jpg', IMG);
  assert.equal(gallery(db, a).length, 1);
  assert.equal(gallery(db, b).length, 1);
});
test('unknown code returns null', () => assert.equal(gallery(setup().db, 'NOPE'), null));
test('path traversal in filename is neutralised', async () => {
  const { db, dir } = setup();
  const c = walk(db, 'A'); serveNext(db, 1);
  await ingest(db, dir, 1, '../../evil.jpg', IMG);
  assert.ok(!fs.existsSync(path.join(dir, '..', 'evil.jpg')));
  assert.equal(gallery(db, c).length, 1);
});

test('shot is rejected if the served family changed during upload', async () => {
  const { db, dir } = setup();
  const a = walk(db, 'A'); walk(db, 'B');
  serveNext(db, 1);
  serveNext(db, 1); // host moved on while A's shot was uploading
  await assert.rejects(() => ingest(db, dir, 1, 'a.jpg', IMG, a), /no active family/);
  assert.equal(gallery(db, a).length, 0);
});
