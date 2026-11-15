const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { openDb } = require('../server/db');
const { book } = require('../server/booking');
const { checkIn, addWalkIn, serveNext, setPresence } = require('../server/queue');
const { ingest } = require('../server/photos');
const { saveCart, pay } = require('../server/orders');
const { dashboard } = require('../server/stats');

const T = (m) => new Date(Date.parse('2026-12-20T10:00:00Z') + m * 60000);
const R = { from: '2026-12-20', to: '2026-12-20', country: 'SN', now: T(300) };
const P = { name: 'Fam', phone: '+221700000000', consent: true };

async function seed() {
  const db = openDb();
  db.prepare("INSERT INTO malls(id,name,country) VALUES(1,'Dakar','SN'),(2,'Cotonou','BJ')").run();
  db.prepare("INSERT INTO slots(id,mall_id,start_at,capacity) VALUES(1,1,'2026-12-20T10:00:00.000Z',5)").run();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmp-'));
  const img = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#808080' } }).jpeg().toBuffer();
  const a = book(db, { ...P, slotId: 1 }, T(-60)).code;
  checkIn(db, a, T(0), 1, 'Fatou');                       // host Fatou: 1 check-in
  const b = addWalkIn(db, 1, { ...P, staff: 'Fatou' }, T(1)).code; // + 1 walk-in
  const c = addWalkIn(db, 1, { ...P, staff: 'Moussa' }, T(2)).code; // host Moussa: 1 walk-in
  setPresence(db, 1, 'photographer', 'Awa', T(3));
  serveNext(db, 1, { now: T(5), staff: 'Fatou' });         // a served by Fatou
  const f1 = (await ingest(db, dir, 1, 'a.jpg', img)).file; await ingest(db, dir, 1, 'b.jpg', img); await ingest(db, dir, 1, 'c.jpg', img);
  saveCart(db, a, [{ item: 'famille', qty: 1 }], [f1]);
  pay(db, a, { method: 'cash', amountReceived: 10000, expectedTotal: 10000, cashier: 'Amy' }, T(20));
  setPresence(db, 1, 'photographer', 'Ibou', T(21));
  serveNext(db, 1, { now: T(22), staff: 'Moussa' });       // b served by Moussa, shot by Ibou
  const f2 = (await ingest(db, dir, 1, 'd.jpg', img)).file;
  saveCart(db, b, [{ item: 'essentiel', qty: 1 }], [f2]);
  pay(db, b, { method: 'mobile_money', provider: 'Wave', reference: 'R1', expectedTotal: 7500, cashier: 'Bob' }, T(40));
  return { db, c };
}

test('hosts: check-ins, walk-ins added and families sent to the photographer, per person', async () => {
  const { db } = await seed();
  assert.deepEqual(dashboard(db, R).team.hosts, [
    { name: 'Fatou', checkins: 1, walkins: 1, served: 1 },
    { name: 'Moussa', checkins: 0, walkins: 1, served: 1 },
  ]);
});
test('photographers: families, photos, average per family and the sales their sessions led to', async () => {
  const { db } = await seed();
  assert.deepEqual(dashboard(db, R).team.photographers, [
    { name: 'Awa', families: 1, photos: 3, avgPhotos: 3, sales: 1, revenue: 10000 },
    { name: 'Ibou', families: 1, photos: 1, avgPhotos: 1, sales: 1, revenue: 7500 },
  ]);
});
test('cashiers: orders, revenue, cash and Mobile Money, average order', async () => {
  const { db } = await seed();
  assert.deepEqual(dashboard(db, R).team.cashiers, [
    { name: 'Amy', orders: 1, revenue: 10000, cash: 10000, mobile_money: 0, avgOrder: 10000 },
    { name: 'Bob', orders: 1, revenue: 7500, cash: 0, mobile_money: 7500, avgOrder: 7500 },
  ]);
});
test('who is on duty: last person seen per role and mall; other countries and days are left out', async () => {
  const { db } = await seed();
  const d = dashboard(db, R);
  const duty = Object.fromEntries(d.team.onDuty.map((x) => [x.role, x.name]));
  assert.deepEqual(duty, { host: 'Moussa', photographer: 'Ibou', cashier: 'Bob' });
  assert.equal(d.team.onDuty[0].mall, 'Dakar');
  assert.deepEqual(dashboard(db, { ...R, country: 'BJ' }).team, { hosts: [], photographers: [], cashiers: [], onDuty: [] });
  assert.deepEqual(dashboard(db, { ...R, from: '2026-12-21', to: '2026-12-21' }).team.hosts, []);
});
test('actions with no name are grouped under "—", never dropped', async () => {
  const db = openDb();
  db.prepare("INSERT INTO malls(id,name,country) VALUES(1,'Dakar','SN')").run();
  addWalkIn(db, 1, P, T(0));
  assert.deepEqual(dashboard(db, R).team.hosts, [{ name: '—', checkins: 0, walkins: 1, served: 0 }]);
});
