const { newCode, cleanText, GRACE_MS } = require('./booking');
const { tx, mallById } = require('./db');

const ORDER = "ORDER BY (kind='walkin'), sort_at, id"; // on-time appointments by slot, then walk-ins by arrival

// Remembers who is working a role at a mall (the last name seen), for the dashboard and to credit photos.
function setPresence(db, mallId, role, name, now = new Date()) {
  const n = cleanText(name, 40);
  if (!n) return null;
  db.prepare(`INSERT INTO presence(mall_id,role,name,seen_at) VALUES(?,?,?,?)
    ON CONFLICT(mall_id,role) DO UPDATE SET name=excluded.name, seen_at=excluded.seen_at`).run(mallId, role, n, now.toISOString());
  return n;
}

function position(db, mallId, code) {
  return getQueue(db, mallId).filter((q) => q.state === 'waiting').findIndex((q) => q.code === code) + 1;
}

// mallId: the host's mall. A code booked for another mall is refused instead of silently joining that mall's queue.
function checkIn(db, code, now = new Date(), mallId = null, staff = '') {
  return tx(db, () => {
    const existing = db.prepare('SELECT * FROM queue WHERE code=?').get(String(code || ''));
    if (existing) {
      if (mallId !== null && existing.mall_id !== mallId) throw new Error('wrong mall');
      return { kind: existing.kind, position: position(db, existing.mall_id, existing.code) };
    }
    const b = db.prepare(`SELECT b.id, b.code, b.name, b.phone, b.status, s.start_at, s.mall_id
      FROM bookings b JOIN slots s ON s.id=b.slot_id WHERE b.code=?`).get(String(code || ''));
    if (!b || b.status === 'cancelled') throw new Error('unknown code');
    if (mallId !== null && b.mall_id !== mallId) throw new Error('wrong mall');
    const late = +now - Date.parse(b.start_at) > GRACE_MS; // after 30 min: treated as walk-in
    const kind = late ? 'walkin' : 'appointment';
    db.prepare('INSERT INTO queue(mall_id,booking_id,code,name,phone,kind,sort_at,checked_in_at,checked_in_by) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(b.mall_id, b.id, b.code, b.name, b.phone, kind, late ? now.toISOString() : new Date(b.start_at).toISOString(), now.toISOString(),
        setPresence(db, b.mall_id, 'host', staff, now));
    db.prepare("UPDATE bookings SET status='checked_in' WHERE id=?").run(b.id);
    return { kind, position: position(db, b.mall_id, b.code) };
  });
}

function addWalkIn(db, mallId, /** @type {any} */ input, now = new Date()) {
  const { name, phone, consent, staff } = input || {};
  const mall = mallById(db, mallId);
  if (consent !== true) throw new Error('consent');
  const n = cleanText(name, 80);
  if (!n) throw new Error('name required');
  return tx(db, () => {
    let code = newCode();
    while (db.prepare('SELECT 1 FROM bookings WHERE code=? UNION SELECT 1 FROM queue WHERE code=?').get(code, code)) code = newCode();
    db.prepare("INSERT INTO queue(mall_id,code,name,phone,kind,sort_at,checked_in_at,checked_in_by) VALUES(?,?,?,?,'walkin',?,?,?)")
      .run(mall.id, code, n, cleanText(phone, 24), now.toISOString(), now.toISOString(), setPresence(db, mall.id, 'host', staff, now));
    return { code };
  });
}

function getQueue(db, mallId) {
  return db.prepare(`SELECT code, name, kind, state FROM queue WHERE mall_id=? AND state!='done' ${ORDER}`).all(mallId);
}

const active = (db, mallId) => db.prepare("SELECT code, name FROM queue WHERE mall_id=? AND state='serving'").get(mallId) || null;

function serveNext(db, mallId, { force = false, now = new Date(), staff = '' } = {}) {
  mallById(db, mallId);
  return tx(db, () => {
    const open = db.prepare(`SELECT 1 FROM queue q JOIN orders o ON o.code=q.code
      WHERE q.mall_id=? AND q.state='serving' AND o.paid_at IS NULL AND o.total>0`).get(mallId);
    if (open && !force) throw new Error('unpaid order');
    db.prepare("UPDATE queue SET state='done' WHERE mall_id=? AND state='serving'").run(mallId);
    const next = db.prepare(`SELECT code, name FROM queue WHERE mall_id=? AND state='waiting' ${ORDER} LIMIT 1`).get(mallId);
    if (!next) return null;
    db.prepare("UPDATE queue SET state='serving', served_at=?, served_by=? WHERE code=?").run(now.toISOString(), setPresence(db, mallId, 'host', staff, now), next.code);
    return { code: next.code, name: next.name };
  });
}
module.exports = { checkIn, addWalkIn, getQueue, serveNext, active, setPresence };
