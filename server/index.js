// Entry point. Hosting loads this file itself, so it starts the server unconditionally (no "run directly" guard).
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./db');
const { createServer } = require('./app');

const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
let pins;
try { pins = JSON.parse(process.env.PINS || '{}'); } catch { pins = null; }
const ROLES = ['host', 'photographer', 'cashier', 'monitor', 'admin'];
const given = pins ? ROLES.concat(pins.printer === undefined ? [] : ['printer']) : []; // printer is optional: without it the print script uses the admin PIN
if (!pins || !given.every((r) => typeof pins[r] === 'string' && pins[r].length >= 4) || new Set(given.map((r) => pins[r])).size !== given.length) {
  console.error('Set PINS to JSON with a different PIN (4+ characters) for each of: ' + ROLES.join(', ') + ' (and optionally printer)');
  process.exit(1);
}
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => { console.error('uncaughtException:', e); process.exit(1); });

fs.mkdirSync(path.join(dir, 'photos'), { recursive: true });
const db = openDb(path.join(dir, 'app.db'));
const server = createServer({ db, dir: path.join(dir, 'photos'), pins });
server.on('clientError', (_, socket) => socket.destroy());
server.listen(process.env.PORT || 3000, () => console.log('up'));
process.on('SIGTERM', () => server.close(() => { db.close(); process.exit(0); }));
