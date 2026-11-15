// Entry point for hosting: always starts the server (no "run directly" guard, hosts load this file themselves).
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./db');
const { createServer } = require('./index');

const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(path.join(dir, 'photos'), { recursive: true });
const pins = JSON.parse(process.env.PINS || '{}');
if (!Object.keys(pins).length) { console.error('Set PINS, e.g. {"host":"1111","photographer":"2222","cashier":"3333","monitor":"4444","admin":"9999"}'); process.exit(1); }
const db = openDb(path.join(dir, 'app.db'));
createServer({ db, dir: path.join(dir, 'photos'), pins }).listen(process.env.PORT || 3000, () => console.log('up'));
