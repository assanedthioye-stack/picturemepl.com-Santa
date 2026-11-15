const fs = require('node:fs');
const path = require('node:path');

const IMAGE = /\.(jpe?g|png)$/i;

function ingest(db, dir, mallId, filename, bytes, expectedCode) {
  const f = db.prepare("SELECT code FROM queue WHERE mall_id=? AND state='serving'").get(mallId);
  if (!f || (expectedCode && f.code !== expectedCode)) throw new Error('no active family'); // host moved on mid-upload: reject, never misfile
  const base = path.basename(String(filename || '')).replace(/[^\w.-]/g, '_');
  if (!IMAGE.test(base) || !bytes || !bytes.length) throw new Error('bad file'); // images only: anything else could be served back as a page
  const n = db.prepare('SELECT COALESCE(MAX(id),0) n FROM photos').get().n + 1;
  const file = n + '_' + base;
  fs.mkdirSync(path.join(dir, f.code), { recursive: true });
  fs.writeFileSync(path.join(dir, f.code, file), bytes);
  db.prepare('INSERT INTO photos(code,file,created_at) VALUES(?,?,?)').run(f.code, file, new Date().toISOString());
  return { code: f.code, file };
}

function gallery(db, code) {
  if (!db.prepare('SELECT 1 FROM queue WHERE code=?').get(String(code || ''))) return null;
  return db.prepare('SELECT file FROM photos WHERE code=? ORDER BY id').all(code).map((r) => r.file);
}
module.exports = { ingest, gallery, IMAGE };
