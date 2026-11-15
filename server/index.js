// Entry point. Hosting loads this file itself, so it starts the server unconditionally (no "run directly" guard).
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./db');
const { createServer } = require('./app');

const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
let pins;
try { pins = JSON.parse(process.env.PINS || '{}'); } catch { pins = null; }
// Device PINs. Hosts, photographers and cashiers each sign in with a personal PIN created on the admin page.
const need = pins ? ['admin', 'monitor'].concat(pins.printer === undefined ? [] : ['printer']) : [];
if (!pins || !need.every((r) => typeof pins[r] === 'string' && pins[r].length >= 4) || new Set(need.map((r) => pins[r])).size !== need.length) {
  console.error('Set PINS to JSON with a different PIN (4+ characters) for: admin, monitor (and optionally printer)');
  process.exit(1);
}
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => { console.error('uncaughtException:', e); process.exit(1); });

fs.mkdirSync(path.join(dir, 'photos'), { recursive: true });
const db = openDb(path.join(dir, 'app.db'));
// Key for hashing personal PINs. Kept in its own file so a copy of the database alone does not reveal it.
const keyFile = path.join(dir, 'pin.key');
if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, require('node:crypto').randomBytes(32).toString('hex'), { mode: 0o600 });
const secret = fs.readFileSync(keyFile, 'utf8').trim();
const server = createServer({ db, dir: path.join(dir, 'photos'), pins, secret });
server.on('clientError', (_, socket) => socket.destroy());
server.listen(process.env.PORT || 3000, () => console.log('up'));
process.on('SIGTERM', () => server.close(() => { db.close(); process.exit(0); }));
