import { Router } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getSetting, schema, setSetting, writeSynced, type Db } from '@pmp/db';
import { COUNTRIES, MOMO_METHODS, packageId, PRINT_SIZES } from '@pmp/shared';
import type { Deps } from '../app';
import { audit } from '../audit';
import { requirePerm, staffOf } from '../auth/auth';
import { HttpError } from '../http';
import { uuidv7 } from '../ids';
import { toDto } from '../photos/ingest';
import { PRICE_LIST, PRICE_LIST_VERSION, priceCart, type Pkg } from '../pos/pricing';
import { kioskState, setKioskSession } from './kiosk';


const NewOrder = z.object({
  bookingId: z.string().min(1),
  lines: z.array(z.object({ packageId: z.string().min(1), qty: z.number().int().min(1).max(20) })).max(10),
  digitalPhotoIds: z.array(z.string()).max(500),
  printSlots: z.array(z.object({ size: z.enum(PRINT_SIZES), photoId: z.string() })).max(100),
});
const Pay = z.discriminatedUnion('method', [
  z.object({ method: z.literal('cash'), tenderedXof: z.number().int().min(0).max(100_000_000) }),
  z.object({ method: z.enum(MOMO_METHODS), reference: z.string().trim().min(4).max(64), payerPhone: z.string().max(25).optional() }),
]);
const OpenDrawer = z.object({ openingFloatXof: z.number().int().min(0).max(100_000_000) });
const CloseDrawer = z.object({ countedXof: z.number().int().min(0).max(100_000_000) });

/** Installs the official price list once per version; older packages stay in the DB (history) but inactive. */
export function seedPackages(db: Db): void {
  if (getSetting(db, 'packages.version') === PRICE_LIST_VERSION) return;
  // shortcut: replaces every package, which is right while prices only come from code; the Phase 3 Admin screen must own this instead
  db.transaction((tx) => {
    for (const old of tx.select().from(schema.packages).all()) writeSynced(tx, schema.packages, { id: old.id, active: false });
    for (const { price, ...p } of PRICE_LIST) {
      for (const country of Object.keys(COUNTRIES) as Array<keyof typeof COUNTRIES>) {
        const existing = tx.select({ id: schema.packages.id }).from(schema.packages)
          .where(and(eq(schema.packages.code, p.code), eq(schema.packages.country, country))).get();
        writeSynced(tx, schema.packages, { id: existing?.id ?? packageId(p.code, country), ...p, prints: { ...p.prints }, country, priceXof: price[country], active: true });
      }
    }
    setSetting(tx as unknown as Db, 'packages.version', PRICE_LIST_VERSION);
  });
}

const vatBp = (db: Db) => Number(getSetting(db, 'tax.vat_bp') ?? 1800); // SN, BJ and CI all charge 18 % VAT

function openDrawer(db: Db, boothId: string) {
  return db.select().from(schema.drawerSessions)
    .where(and(eq(schema.drawerSessions.boothId, boothId), eq(schema.drawerSessions.status, 'open'))).get();
}

export function posRoutes({ db, hub, boothId, printQueue, config }: Deps): Router {
  const r = Router();
  const forBooth = and(eq(schema.packages.active, true), eq(schema.packages.country, config.country));
  const P = schema.photos;

  r.get('/api/pos/packages', requirePerm('payment.take'), (_req, res) => {
    res.json(db.select().from(schema.packages).where(forBooth).orderBy(schema.packages.sort).all());
  });

  // Families whose shoot is finished and who have not paid yet.
  r.get('/api/pos/families', requirePerm('payment.take'), (_req, res) => {
    const photoCount = sql<number>`(select count(*) from photos p where p.booking_id = ${schema.bookings.id} and p.ingest_status = 'ready' and p.hidden = 0)`;
    const favCount = sql<number>`(select count(*) from photos p where p.booking_id = ${schema.bookings.id} and p.ingest_status = 'ready' and p.hidden = 0 and p.favorite = 1)`;
    const lastSession = sql<string>`(select s.id from photo_sessions s where s.booking_id = ${schema.bookings.id} order by s.created_at desc limit 1)`;
    res.json(db.select({
      bookingId: schema.bookings.id, bookingCode: schema.bookings.code, familyName: schema.customers.fullName,
      partySize: schema.bookings.partySize, photoCount, favCount, sessionId: lastSession, updatedAt: schema.bookings.updatedAt,
    }).from(schema.bookings).innerJoin(schema.customers, eq(schema.customers.id, schema.bookings.customerId))
      .where(and(eq(schema.bookings.boothId, boothId), eq(schema.bookings.status, 'shot_complete')))
      .orderBy(schema.bookings.updatedAt).all());
  });

  r.get('/api/pos/families/:bookingId/photos', requirePerm('payment.take'), (req, res) => {
    res.json(db.select().from(P)
      .where(and(eq(P.bookingId, String(req.params.bookingId)), eq(P.ingestStatus, 'ready'), eq(P.hidden, false)))
      .orderBy(P.takenAt).all().map(toDto));
  });

  // Puts this family on the customer screen so they can point at their favourites.
  r.post('/api/pos/families/:bookingId/show', requirePerm('payment.take'), (req, res) => {
    const s = db.select({ id: schema.photoSessions.id }).from(schema.photoSessions)
      .where(eq(schema.photoSessions.bookingId, String(req.params.bookingId))).orderBy(desc(schema.photoSessions.createdAt)).get();
    if (!s) throw new HttpError(404, 'session_not_found');
    setKioskSession(db, s.id);
    hub.send('kiosk.state', kioskState(db), ['staff', 'kiosk']);
    res.json({ ok: true });
  });

  r.post('/api/pos/orders', requirePerm('payment.take'), (req, res) => {
    const body = NewOrder.parse(req.body);
    const user = staffOf(req);
    const booking = db.select().from(schema.bookings).where(eq(schema.bookings.id, body.bookingId)).get();
    if (!booking || booking.boothId !== boothId) throw new HttpError(404, 'booking_not_found');
    if (booking.status !== 'shot_complete') throw new HttpError(409, `booking_${booking.status}`);
    const pkgs = new Map<string, Pkg & { code: string }>(db.select().from(schema.packages)
      .where(forBooth).all().map((p) => [p.id, p]));
    const photoIds = new Set(db.select({ id: P.id }).from(P)
      .where(and(eq(P.bookingId, booking.id), eq(P.ingestStatus, 'ready'), eq(P.hidden, false))).all().map((p) => p.id));
    const rate = vatBp(db);
    let priced;
    try { priced = priceCart(pkgs, body, rate, photoIds); } catch (e) { throw new HttpError(400, (e as Error).message); }

    const order = db.transaction((tx) => {
      // One open order per family: rebuilding the cart replaces it.
      for (const o of tx.select({ id: schema.orders.id }).from(schema.orders)
        .where(and(eq(schema.orders.bookingId, booking.id), eq(schema.orders.status, 'open'))).all()) {
        writeSynced(tx, schema.orders, { id: o.id, status: 'void' });
      }
      const o = writeSynced(tx, schema.orders, {
        id: uuidv7(), bookingId: booking.id, boothId, channel: 'booth', cashierId: user.id, status: 'open',
        subtotalXof: priced.subtotalXof, totalXof: priced.totalXof, vatBp: rate, vatXof: priced.vatXof,
      });
      const item = (v: Omit<typeof schema.orderItems.$inferInsert, 'id' | 'orderId'>) =>
        writeSynced(tx, schema.orderItems, { id: uuidv7(), orderId: o.id, ...v });
      for (const l of body.lines) {
        const p = pkgs.get(l.packageId)!;
        item({ packageId: p.id, kind: 'bundle', qty: l.qty, unitPriceXof: p.priceXof, lineTotalXof: p.priceXof * l.qty });
      }
      // Entitlement lines (price is carried by the bundle line above).
      for (const photoId of body.digitalPhotoIds) item({ photoId, kind: 'digital', qty: 1, unitPriceXof: 0, lineTotalXof: 0 });
      const prints = new Map<string, number>();
      for (const s of body.printSlots) prints.set(`${s.size}|${s.photoId}`, (prints.get(`${s.size}|${s.photoId}`) ?? 0) + 1);
      for (const [k, qty] of prints) {
        const [size, photoId] = k.split('|') as [typeof PRINT_SIZES[number], string];
        item({ photoId, kind: 'print', printSize: size, qty, unitPriceXof: 0, lineTotalXof: 0 });
      }
      return o;
    });
    audit(db, boothId, { action: 'order.create', actorId: user.id, actorRole: user.role, entity: 'order', entityId: order.id, data: { total: order.totalXof } });
    res.status(201).json(order);
  });

  r.post('/api/pos/orders/:id/pay', requirePerm('payment.take'), (req, res) => {
    const body = Pay.parse(req.body);
    const user = staffOf(req);
    const now = Date.now();
    const result = db.transaction((tx) => {
      const order = tx.select().from(schema.orders).where(eq(schema.orders.id, String(req.params.id))).get();
      if (!order || order.boothId !== boothId) throw new HttpError(404, 'order_not_found');
      if (order.status !== 'open') throw new HttpError(409, `order_${order.status}`); // also stops double taps
      let drawerId: string | null = null;
      if (body.method === 'cash') {
        const drawer = openDrawer(tx as unknown as Db, boothId);
        if (!drawer) throw new HttpError(409, 'drawer_closed');
        if (body.tenderedXof < order.totalXof) throw new HttpError(400, 'tendered_too_low');
        drawerId = drawer.id;
      } else {
        if (!(COUNTRIES[config.country].momo as readonly string[]).includes(body.method)) throw new HttpError(400, 'method_not_offered');
        const dup = tx.select({ id: schema.payments.id }).from(schema.payments)
          .where(and(eq(schema.payments.method, body.method), eq(schema.payments.providerTxId, body.reference))).get();
        if (dup) throw new HttpError(409, 'reference_already_used');
      }
      const payment = writeSynced(tx, schema.payments, {
        id: uuidv7(), orderId: order.id, method: body.method, idempotencyKey: uuidv7(),
        // shortcut: Mobile Money is confirmed by the cashier from the customer's receipt; provider push + webhook arrive with the cloud (Phase 3)
        provider: body.method === 'cash' ? null : 'manual',
        providerTxId: body.method === 'cash' ? null : body.reference,
        payerPhone: body.method === 'cash' ? null : body.payerPhone ?? null,
        amountXof: order.totalXof, status: 'succeeded', receivedBy: user.id, drawerSessionId: drawerId, confirmedAt: now,
      });
      if (drawerId) {
        writeSynced(tx, schema.cashMovements, { id: uuidv7(), drawerSessionId: drawerId, kind: 'sale', amountXof: order.totalXof, paymentId: payment.id, byUser: user.id });
      }
      writeSynced(tx, schema.orders, { id: order.id, status: 'paid', paidAt: now });
      writeSynced(tx, schema.bookings, { id: order.bookingId, status: 'completed' });

      // Paid → prints go to the router, purchased originals to the upload queue.
      const items = tx.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, order.id)).all();
      for (const it of items.filter((i) => i.kind === 'print')) {
        writeSynced(tx, schema.printJobs, {
          id: uuidv7(), boothId, orderItemId: it.id, photoId: it.photoId!, printSize: it.printSize!,
          copies: it.qty, status: 'queued', requestedBy: user.id,
        });
      }
      for (const it of items.filter((i) => i.kind === 'digital')) {
        tx.insert(schema.uploadJobs).values({ id: uuidv7(), photoId: it.photoId!, kind: 'deliverable', priority: 10, status: 'queued', createdAt: now })
          .onConflictDoUpdate({ target: [schema.uploadJobs.photoId, schema.uploadJobs.kind], set: { priority: 10 } }).run();
      }
      return { order, payment, change: body.method === 'cash' ? body.tenderedXof - order.totalXof : 0 };
    });
    audit(db, boothId, {
      action: 'payment.take', actorId: user.id, actorRole: user.role, entity: 'payment', entityId: result.payment.id,
      data: { method: body.method, amount: result.payment.amountXof, reference: result.payment.providerTxId },
    });
    printQueue.kick();
    hub.send('order.paid', { orderId: result.order.id, bookingId: result.order.bookingId });
    res.json({ paymentId: result.payment.id, changeXof: result.change });
  });

  // ─── cash drawer ───
  r.get('/api/pos/drawer', requirePerm('payment.take'), (_req, res) => {
    const d = openDrawer(db, boothId);
    // Blind: the expected amount is never shown while the drawer is open.
    res.json(d ? { id: d.id, openedAt: d.openedAt, openedBy: d.openedBy, openingFloatXof: d.openingFloatXof } : null);
  });

  r.post('/api/pos/drawer/open', requirePerm('payment.take'), (req, res) => {
    const { openingFloatXof } = OpenDrawer.parse(req.body);
    const user = staffOf(req);
    if (openDrawer(db, boothId)) throw new HttpError(409, 'drawer_already_open');
    const d = writeSynced(db, schema.drawerSessions, { id: uuidv7(), boothId, openedBy: user.id, openedAt: Date.now(), openingFloatXof, status: 'open' });
    audit(db, boothId, { action: 'drawer.open', actorId: user.id, actorRole: user.role, entity: 'drawer', entityId: d.id, data: { openingFloatXof } });
    res.status(201).json({ id: d.id });
  });

  r.post('/api/pos/drawer/close', requirePerm('payment.take'), (req, res) => {
    const { countedXof } = CloseDrawer.parse(req.body);
    const user = staffOf(req);
    const d = openDrawer(db, boothId);
    if (!d) throw new HttpError(409, 'drawer_closed');
    const moved = db.select({ s: sql<number>`coalesce(sum(${schema.cashMovements.amountXof}), 0)` }).from(schema.cashMovements)
      .where(eq(schema.cashMovements.drawerSessionId, d.id)).get()!.s;
    const expectedXof = d.openingFloatXof + moved;
    const row = writeSynced(db, schema.drawerSessions, {
      id: d.id, status: 'counted', closedBy: user.id, closedAt: Date.now(), countedXof, expectedXof, varianceXof: countedXof - expectedXof,
    });
    audit(db, boothId, { action: 'drawer.close', actorId: user.id, actorRole: user.role, entity: 'drawer', entityId: d.id, data: { countedXof, expectedXof } });
    res.json({ expectedXof, countedXof, varianceXof: row.varianceXof });
  });

  return r;
}

