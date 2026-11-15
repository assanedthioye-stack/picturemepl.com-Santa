const { DatabaseSync } = require('node:sqlite');

const PRICES = {
  SN: { essentiel: 7500, famille: 10000, prestige: 18000, numerique: 5000, print_8x10: 3500, print_5x7: 2500, print_4x6: 1500, wallet: 1500 },
  CI: { essentiel: 9000, famille: 12000, prestige: 21500, numerique: 6000, print_8x10: 4000, print_5x7: 3500, print_4x6: 2000, wallet: 2000 },
  BJ: { essentiel: 6500, famille: 8500, prestige: 15500, numerique: 4500, print_8x10: 3000, print_5x7: 2500, print_4x6: 1500, wallet: 1500 },
};

function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS malls(id INTEGER PRIMARY KEY, name TEXT, country TEXT);
    CREATE TABLE IF NOT EXISTS slots(id INTEGER PRIMARY KEY, mall_id INTEGER, start_at TEXT, capacity INTEGER);
    CREATE TABLE IF NOT EXISTS bookings(id INTEGER PRIMARY KEY, code TEXT UNIQUE, slot_id INTEGER, name TEXT, phone TEXT, consent INTEGER, status TEXT DEFAULT 'booked', created_at TEXT);
    CREATE TABLE IF NOT EXISTS queue(id INTEGER PRIMARY KEY, mall_id INTEGER, booking_id INTEGER, code TEXT UNIQUE, name TEXT, phone TEXT, kind TEXT, sort_at TEXT, checked_in_at TEXT, state TEXT DEFAULT 'waiting', served_at TEXT);
    CREATE TABLE IF NOT EXISTS photos(id INTEGER PRIMARY KEY, code TEXT, file TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, code TEXT UNIQUE, items_json TEXT, files_json TEXT, lines_json TEXT, total INTEGER, method TEXT, provider TEXT, reference TEXT, amount_received INTEGER, paid_at TEXT, cashier TEXT, print_state TEXT DEFAULT 'none', download_expires_at TEXT, download_token TEXT);
    CREATE TABLE IF NOT EXISTS staff(id INTEGER PRIMARY KEY, name TEXT, role TEXT, pin_hmac TEXT UNIQUE, active INTEGER DEFAULT 1, created_at TEXT);
    CREATE TABLE IF NOT EXISTS presence(mall_id INTEGER, role TEXT, name TEXT, seen_at TEXT, PRIMARY KEY(mall_id, role));
    CREATE TABLE IF NOT EXISTS prices(country TEXT, item TEXT, amount INTEGER, PRIMARY KEY(country,item));
  `);
  for (const add of ['queue ADD COLUMN served_at TEXT', 'orders ADD COLUMN download_token TEXT', 'queue ADD COLUMN checked_in_by TEXT',
    'queue ADD COLUMN served_by TEXT', 'photos ADD COLUMN photographer TEXT']) {
    try { db.exec('ALTER TABLE ' + add); } catch { /* column already there */ }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS i_slots_mall ON slots(mall_id, start_at);
    CREATE INDEX IF NOT EXISTS i_bookings_slot ON bookings(slot_id);
    CREATE INDEX IF NOT EXISTS i_queue_mall ON queue(mall_id, state);
    CREATE INDEX IF NOT EXISTS i_photos_code ON photos(code);
  `);
  const ins = db.prepare('INSERT OR IGNORE INTO prices(country,item,amount) VALUES(?,?,?)');
  for (const [c, m] of Object.entries(PRICES)) {
    for (const [k, v] of Object.entries(m)) ins.run(c, k, v);
    ins.run(c, 'digital', m.numerique); // extra digital file priced like Numérique
  }
  return db;
}

// Runs fn atomically: all of its writes land, or none do.
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function priceMap(db, country) {
  const m = {};
  for (const r of db.prepare('SELECT item, amount FROM prices WHERE country=?').all(country)) m[r.item] = r.amount;
  return m;
}

function mallById(db, id) {
  const m = Number.isInteger(id) ? db.prepare('SELECT id,name,country FROM malls WHERE id=?').get(id) : null;
  if (!m) throw new Error('unknown mall');
  return m;
}
module.exports = { openDb, tx, priceMap, mallById };
