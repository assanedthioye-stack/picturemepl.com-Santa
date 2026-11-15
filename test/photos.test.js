const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../server/db');
const { addWalkIn, serveNext } = require('../server/queue');
const { ingest, gallery } = require('../server/photos');

function setup() {
  const db = openDb();
  db.prepare("INSERT INTO malls(id,name,country) VALUES(1,'M','SN')").run();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmp-'));
  return { db, dir };
}
const walk = (db, n) => addWalkIn(db, 1, { name: n, phone: '+221700000000', consent: true }).code;

test('ingest stores and lists for the serving family', () => {
  const { db, dir } = setup();
  const c = walk(db, 'A');
  serveNext(db, 1);
  const r = ingest(db, dir, 1, 'IMG_1.jpg', Buffer.from('x'));
  assert.equal(r.code, c);
  assert.equal(gallery(db, c).length, 1);
  assert.ok(fs.existsSync(path.join(dir, c, gallery(db, c)[0])));
});
test('no active family throws', () => {
  const { db, dir } = setup();
  assert.throws(() => ingest(db, dir, 1, 'a.jpg', Buffer.from('x')), /no active family/);
});
test('next family gets only new shots', () => {
  const { db, dir } = setup();
  const a = walk(db, 'A'), b = walk(db, 'B');
  serveNext(db, 1); ingest(db, dir, 1, 'a.jpg', Buffer.from('x'));
  serveNext(db, 1); ingest(db, dir, 1, 'b.jpg', Buffer.from('y'));
  assert.equal(gallery(db, a).length, 1);
  assert.equal(gallery(db, b).length, 1);
});
test('unknown code returns null', () => assert.equal(gallery(setup().db, 'NOPE'), null));
test('path traversal in filename is neutralised', () => {
  const { db, dir } = setup();
  const c = walk(db, 'A'); serveNext(db, 1);
  ingest(db, dir, 1, '../../evil.jpg', Buffer.from('x'));
  assert.ok(!fs.existsSync(path.join(dir, '..', 'evil.jpg')));
  assert.equal(gallery(db, c).length, 1);
});

test('shot is rejected if the served family changed during upload', () => {
  const { db, dir } = setup();
  const a = walk(db, 'A'); walk(db, 'B');
  serveNext(db, 1);
  serveNext(db, 1); // host moved on while A's shot was uploading
  assert.throws(() => ingest(db, dir, 1, 'a.jpg', Buffer.from('x'), a), /no active family/);
  assert.equal(gallery(db, a).length, 0);
});
