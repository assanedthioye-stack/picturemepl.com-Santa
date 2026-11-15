const crypto = require('node:crypto');
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const newCode = () => Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % 32]).join('');

function listSlots(db, mallId, day) {
  return db.prepare(`SELECT s.id, s.start_at, s.capacity,
      s.capacity - (SELECT COUNT(*) FROM bookings b WHERE b.slot_id=s.id AND b.status!='cancelled') AS remaining
    FROM slots s WHERE s.mall_id=? AND s.start_at LIKE ? ORDER BY s.start_at`).all(mallId, day + '%');
}

function book(db, { slotId, name, phone, consent }) {
  if (!consent) throw new Error('consent');
  if (!name || !phone) throw new Error('name and phone required');
  db.exec('BEGIN IMMEDIATE'); // blocks concurrent writers so the last spot can't be sold twice
  try {
    const slot = db.prepare('SELECT capacity FROM slots WHERE id=?').get(slotId);
    if (!slot) throw new Error('unknown slot');
    const used = db.prepare("SELECT COUNT(*) n FROM bookings WHERE slot_id=? AND status!='cancelled'").get(slotId).n;
    if (used >= slot.capacity) throw new Error('full');
    const code = newCode();
    db.prepare('INSERT INTO bookings(code,slot_id,name,phone,consent,created_at) VALUES(?,?,?,?,1,?)')
      .run(code, slotId, name, phone, new Date().toISOString());
    db.exec('COMMIT');
    return { code };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function cancel(db, code) {
  db.prepare("UPDATE bookings SET status='cancelled' WHERE code=? AND status='booked'").run(code);
}
module.exports = { listSlots, book, cancel, newCode };
