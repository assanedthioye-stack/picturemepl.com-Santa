// Personal PINs. Each staff member has their own PIN, so every action is tied to a person, not a shared role PIN.
const crypto = require('node:crypto');
const { cleanText } = require('./booking');

const ROLES = ['host', 'photographer', 'cashier', 'admin'];
// PINs are never stored: only a keyed hash, which still allows a direct lookup. The key lives outside the database.
const digest = (secret, pin) => crypto.createHmac('sha256', String(secret)).update(String(pin)).digest('hex');
const bad = () => new Error('bad staff');

function freshPin(db, secret, reserved) {
  for (;;) {
    const pin = String(crypto.randomInt(100000, 1000000));
    if (!reserved.includes(pin) && !db.prepare('SELECT 1 FROM staff WHERE pin_hmac=?').get(digest(secret, pin))) return pin;
  }
}

// reserved: PINs already used by devices (monitor, printer, master admin), which a personal PIN must never equal.
function create(db, secret, /** @type {any} */ input, reserved = []) {
  const { name, role, pin: given } = input || {};
  const n = cleanText(name, 40);
  if (!n || !ROLES.includes(role)) throw bad();
  if (db.prepare('SELECT 1 FROM staff WHERE lower(name)=lower(?) AND role=?').get(n, role)) throw bad(); // already exists
  const pin = given === undefined ? freshPin(db, secret, reserved) : String(given);
  if (pin.length < 4 || reserved.includes(pin) || db.prepare('SELECT 1 FROM staff WHERE pin_hmac=?').get(digest(secret, pin))) throw bad();
  const r = db.prepare('INSERT INTO staff(name,role,pin_hmac,created_at) VALUES(?,?,?,?)').run(n, role, digest(secret, pin), new Date().toISOString());
  return { id: Number(r.lastInsertRowid), pin }; // the only time the PIN is ever available
}

function resetPin(db, secret, id, reserved = []) {
  const pin = freshPin(db, secret, reserved);
  if (!db.prepare('UPDATE staff SET pin_hmac=? WHERE id=?').run(digest(secret, pin), Number.isInteger(id) ? id : -1).changes) throw new Error('unknown staff');
  return { pin };
}

function setActive(db, id, active) {
  if (!db.prepare('UPDATE staff SET active=? WHERE id=?').run(active ? 1 : 0, Number.isInteger(id) ? id : -1).changes) throw new Error('unknown staff');
}

const list = (db) => db.prepare('SELECT id, name, role, active, created_at FROM staff ORDER BY role, name').all().map((s) => ({ ...s, active: !!s.active }));

function find(db, secret, pin) {
  if (typeof pin !== 'string' || pin.length < 4 || pin.length > 64) return null;
  return db.prepare('SELECT id, name, role FROM staff WHERE pin_hmac=? AND active=1').get(digest(secret, pin)) || null;
}
module.exports = { ROLES, create, resetPin, setActive, list, find };
