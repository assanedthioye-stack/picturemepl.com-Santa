const { newCode } = require('./booking');
const GRACE_MS = 30 * 60000;

function position(db, mallId, code) {
  return getQueue(db, mallId).filter((q) => q.state === 'waiting').findIndex((q) => q.code === code) + 1;
}

function checkIn(db, code, now = new Date()) {
  const existing = db.prepare('SELECT * FROM queue WHERE code=?').get(code);
  if (existing) return { kind: existing.kind, position: position(db, existing.mall_id, code) };
  const b = db.prepare(`SELECT b.id, b.name, b.phone, b.status, s.start_at, s.mall_id
    FROM bookings b JOIN slots s ON s.id=b.slot_id WHERE b.code=?`).get(code);
  if (!b || b.status === 'cancelled') throw new Error('unknown code');
  const late = now - new Date(b.start_at) > GRACE_MS; // after 30 min: treated as walk-in
  const kind = late ? 'walkin' : 'appointment';
  db.prepare(`INSERT INTO queue(mall_id,booking_id,code,name,phone,kind,sort_at,checked_in_at) VALUES(?,?,?,?,?,?,?,?)`)
    .run(b.mall_id, b.id, code, b.name, b.phone, kind, late ? now.toISOString() : b.start_at, now.toISOString());
  db.prepare("UPDATE bookings SET status='checked_in' WHERE id=?").run(b.id);
  return { kind, position: position(db, b.mall_id, code) };
}

function addWalkIn(db, mallId, { name, phone, consent }, now = new Date()) {
  if (!consent) throw new Error('consent');
  if (!name) throw new Error('name required');
  const code = newCode();
  db.prepare(`INSERT INTO queue(mall_id,code,name,phone,kind,sort_at,checked_in_at) VALUES(?,?,?,?,'walkin',?,?)`)
    .run(mallId, code, name, phone || '', now.toISOString(), now.toISOString());
  return { code };
}

function getQueue(db, mallId) {
  return db.prepare(`SELECT code, name, kind, state FROM queue WHERE mall_id=? AND state!='done'
    ORDER BY (kind='walkin'), sort_at, id`).all(mallId);
}

function serveNext(db, mallId, { force = false, now = new Date() } = {}) {
  const open = db.prepare(`SELECT 1 FROM queue q JOIN orders o ON o.code=q.code
    WHERE q.mall_id=? AND q.state='serving' AND o.paid_at IS NULL AND o.total>0`).get(mallId);
  if (open && !force) throw new Error('unpaid order');
  db.prepare("UPDATE queue SET state='done' WHERE mall_id=? AND state='serving'").run(mallId);
  const next = db.prepare(`SELECT code, name FROM queue WHERE mall_id=? AND state='waiting'
    ORDER BY (kind='walkin'), sort_at, id LIMIT 1`).get(mallId);
  if (!next) return null;
  db.prepare("UPDATE queue SET state='serving', served_at=? WHERE code=?").run(now.toISOString(), next.code);
  return { code: next.code, name: next.name };
}
module.exports = { checkIn, addWalkIn, getQueue, serveNext };
