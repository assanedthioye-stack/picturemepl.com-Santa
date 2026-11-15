const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const IMAGE = /\.(jpe?g|png)$/i;
const PREVIEW_MAX = 1000; // longest side, in pixels: big enough to choose from, too small to print
const previewName = (file) => 'pv_' + file + '.jpg';

// Small copy with a watermark over the whole picture. Lines are drawn as shapes so the mark never depends on
// fonts being installed on the server; the brand text is added on top where fonts exist.
async function makePreview(bytes) {
  const { data, info } = await sharp(bytes).rotate()
    .resize({ width: PREVIEW_MAX, height: PREVIEW_MAX, fit: 'inside', withoutEnlargement: true }).toBuffer({ resolveWithObject: true });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${info.width}" height="${info.height}"><defs>
    <pattern id="w" width="220" height="110" patternUnits="userSpaceOnUse" patternTransform="rotate(-30)">
      <rect x="0" y="0" width="220" height="5" fill="#fff" fill-opacity=".55"/><rect x="0" y="5" width="220" height="2" fill="#000" fill-opacity=".45"/>
      <text x="8" y="62" font-family="Arial, Helvetica, DejaVu Sans, sans-serif" font-size="20" font-weight="700" fill="#fff" fill-opacity=".7" stroke="#000" stroke-opacity=".5" stroke-width=".8">PICTURE ME PLEASE</text>
    </pattern></defs><rect width="100%" height="100%" fill="url(#w)"/></svg>`;
  return sharp(data).composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 72 }).toBuffer(); // metadata (EXIF, GPS) is dropped
}

async function ingest(db, dir, mallId, filename, bytes, expectedCode, photographer = null) {
  const base = path.basename(String(filename || '')).replace(/[^\w.-]/g, '_');
  if (!IMAGE.test(base) || !bytes || !bytes.length) throw new Error('bad file'); // images only
  let preview;
  try { preview = await makePreview(bytes); } catch { throw new Error('bad file'); } // not really an image
  // Checked AFTER the slow work above: if the host moved on meanwhile, reject rather than misfile.
  const f = db.prepare("SELECT code FROM queue WHERE mall_id=? AND state='serving'").get(mallId);
  if (!f || (expectedCode && f.code !== expectedCode)) throw new Error('no active family');
  const file = (db.prepare('SELECT COALESCE(MAX(id),0) n FROM photos').get().n + 1) + '_' + base;
  fs.mkdirSync(path.join(dir, f.code), { recursive: true });
  fs.writeFileSync(path.join(dir, f.code, file), bytes);
  fs.writeFileSync(path.join(dir, f.code, previewName(file)), preview);
  // Credited to the owner of the PIN that uploaded it; otherwise to whoever is signed in at that mall's camera.
  const by = photographer || db.prepare("SELECT name FROM presence WHERE mall_id=? AND role='photographer'").get(mallId)?.name || null;
  db.prepare('INSERT INTO photos(code,file,created_at,photographer) VALUES(?,?,?,?)').run(f.code, file, new Date().toISOString(), by);
  return { code: f.code, file };
}

function gallery(db, code) {
  if (!db.prepare('SELECT 1 FROM queue WHERE code=?').get(String(code || ''))) return null;
  return db.prepare('SELECT file FROM photos WHERE code=? ORDER BY id').all(code).map((r) => r.file);
}

// Bytes of a recorded photo: the watermarked preview, or the clean original. Unknown files throw 'not found'.
async function read(db, dir, code, file, { clean = false } = {}) {
  const original = path.join(dir, code, file);
  if (!(gallery(db, code) || []).includes(file) || !fs.existsSync(original)) throw new Error('not found');
  if (clean) return fs.promises.readFile(original);
  const pv = path.join(dir, code, previewName(file));
  if (!fs.existsSync(pv)) fs.writeFileSync(pv, await makePreview(await fs.promises.readFile(original))); // photos from before previews existed
  return fs.promises.readFile(pv);
}
module.exports = { ingest, gallery, read, makePreview, IMAGE };
