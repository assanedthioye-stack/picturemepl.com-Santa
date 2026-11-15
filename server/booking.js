const crypto = require('node:crypto');
const { tx, mallById } = require('./db');
const { local, localDay, isDay } = require('./tz');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const newCode = () => Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % 32]).join('');
const GRACE_MS = 30 * 60000;
const bookable = (startAt, now) => Date.parse(startAt) + GRACE_MS > +now; // a slot stays usable through its grace period

// Text a family typed: trimmed, bounded, no control characters.
function cleanText(v, max) {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
  return s.length > max ? '' : s;
}
const cleanPhone = (v) => (typeof v === 'string' && /^\+?[\d\s().-]{6,20}$/.test(v.trim()) ? v.trim() : '');

// Slots of one mall for one LOCAL day, with local start time; past slots are left out.
function listSlots(db, mallId, day, now = new Date()) {
  const mall = mallById(db, mallId);
  if (!isDay(day)) throw new Error('bad day');
  return db.prepare(`SELECT s.id, s.start_at, s.capacity,
      s.capacity - (SELECT COUNT(*) FROM bookings b WHERE b.slot_id=s.id AND b.status!='cancelled') AS remaining
    FROM slots s WHERE s.mall_id=? ORDER BY s.start_at`).all(mall.id)
    .filter((s) => localDay(s.start_at, mall.country) === day && bookable(s.start_at, now))
    .map((s) => ({ ...s, remaining: Math.max(0, s.remaining), local_time: local(s.start_at, mall.country).slice(11, 16) }));
}

function book(db, /** @type {any} */ input, now = new Date()) {
  const { slotId, name, phone, consent } = input || {};
  if (consent !== true) throw new Error('consent');
  const n = cleanText(name, 80), p = cleanPhone(phone);
  if (!n || !p) throw new Error('name and phone required');
  return tx(db, () => { // one writer at a time, so the last spot can't be sold twice
    const slot = Number.isInteger(slotId) ? db.prepare('SELECT capacity, start_at FROM slots WHERE id=?').get(slotId) : null;
    if (!slot) throw new Error('unknown slot');
    if (!bookable(slot.start_at, now)) throw new Error('past');
    const used = db.prepare("SELECT COUNT(*) n FROM bookings WHERE slot_id=? AND status!='cancelled'").get(slotId).n;
    if (used >= slot.capacity) throw new Error('full');
    let code = newCode();
    while (db.prepare('SELECT 1 FROM bookings WHERE code=? UNION SELECT 1 FROM queue WHERE code=?').get(code, code)) code = newCode();
    db.prepare('INSERT INTO bookings(code,slot_id,name,phone,consent,created_at) VALUES(?,?,?,?,1,?)').run(code, slotId, n, p, now.toISOString());
    return { code };
  });
}

function cancel(db, code) {
  const r = db.prepare("UPDATE bookings SET status='cancelled' WHERE code=? AND status='booked'").run(String(code || ''));
  if (!r.changes) throw new Error('unknown code'); // wrong code, already cancelled, or already checked in
}
module.exports = { listSlots, book, cancel, newCode, cleanText, cleanPhone, GRACE_MS };
