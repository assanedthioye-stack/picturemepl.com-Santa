const { openDb } = require('../server/db');
const { book } = require('../server/booking');
const { addWalkIn, serveNext } = require('../server/queue');
const { saveCart, pay } = require('../server/orders');

const T = (m) => new Date(Date.parse('2026-12-20T10:00:00Z') + m * 60000);
function seed() {
  const db = openDb();
  db.prepare("INSERT INTO malls(id,name,country) VALUES(1,'Sea Plaza','SN'),(2,'Cocody','CI')").run();
  db.prepare("INSERT INTO slots(id,mall_id,start_at,capacity) VALUES(1,1,'2026-12-20T09:00:00Z',5)").run();
  book(db, { slotId: 1, name: 'NoShow', phone: '+221700000000', consent: true }); // never checks in
  const w = (mall, at) => addWalkIn(db, mall, { name: 'x', phone: '+221700000000', consent: true }, at).code;
  const a = w(1, T(0)), b = w(1, T(0)), c = w(2, T(0));
  for (const x of [a, b, c]) db.prepare("INSERT INTO photos(code,file) VALUES(?,'p.jpg')").run(x);
  serveNext(db, 1, { now: T(5) }); // A waited 5
  saveCart(db, a, [{ item: 'famille', qty: 1 }, { item: 'print_8x10', qty: 1 }], ['p.jpg']);
  pay(db, a, { method: 'cash', amountReceived: 12800, expectedTotal: 12800, cashier: 'amy' }, T(20));
  serveNext(db, 1, { now: T(15) }); // B waited 15
  saveCart(db, b, [{ item: 'essentiel', qty: 2 }], ['p.jpg']);
  pay(db, b, { method: 'mobile_money', provider: 'Wave', reference: 'R', expectedTotal: 13500, cashier: 'bob' }, T(30));
  serveNext(db, 2, { now: T(10) });
  saveCart(db, c, [{ item: 'numerique', qty: 1 }], ['p.jpg']);
  pay(db, c, { method: 'cash', amountReceived: 6000, expectedTotal: 6000, cashier: 'cy' }, T(25));
  return db;
}
module.exports = { T, seed };
