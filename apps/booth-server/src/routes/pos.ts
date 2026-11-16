import { Router } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getSetting, schema, setSetting, writeSynced, type Db } from '@pmp/db';
import { COUNTRIES, MOMO_METHODS, packageId, PRINT_SIZES } from '@pmp/shared';
import type { Deps } from '../app';
import { audit } from '../audit';
import { requirePerm, staffOf, type StaffUser } from '../auth/auth';
import { CloudError } from '../cloud/client';
import { HttpError } from '../http';
import { uuidv7 } from '../ids';
import { toDto } from '../photos/ingest';
import { fulfilOrder, prepaidCredit, recordOperatorRef } from '../pos/fulfil';
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
  z.object({ method: z.literal('prepaid') }), // already paid online: nothing left to collect
  z.object({ method: z.enum(MOMO_METHODS), reference: z.string().trim().min(4).max(64), payerPhone: z.string().max(25).optional() }),
]);
const CloudPay = z.object({ method: z.enum(MOMO_METHODS), phone: z.string().max(25).optional() });
const Verify = z.object({ operatorRef: z.string().trim().max(64).optional() });
const OpenDrawer = z.object({ openingFloatXof: z.number().int().min(0).max(100_000_000) });
const CloseDrawer = z.object({ countedXof: z.number().int().min(0).max(100_000_000) });
const CLOUD_PROVIDERS = ['cinetpay', 'fedapay', 'mtn'] as const;
/** How long the till waits for the cloud before taking money another way (the network may be down). */
const QUICK_CHECK_MS = 6_000;

/** Installs the official price list once per version; older packages stay in the DB (history) but inactive. */
export function seedPackages(db: Db): void {
  if (getSetting(db, 'packages.version') === PRICE_LIST_VERSION) return;
  // shortcut: replaces every package, which is right while prices only come from code; an Admin screen must own this instead
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

/** VAT in basis points; SN, BJ and CI all charge 18 %. A broken setting falls back instead of producing NaN totals. */
function vatBp(db: Db): number {
  const v = Number(getSetting(db, 'tax.vat_bp') ?? 1800);
  return Number.isInteger(v) && v >= 0 && v <= 5000 ? v : 1800;
}

function openDrawer(db: Db, boothId: string) {
  return db.select().from(schema.drawerSessions)
    .where(and(eq(schema.drawerSessions.boothId, boothId), eq(schema.drawerSessions.status, 'open'))).get();
}

export function posRoutes({ db, hub, boothId, printQueue, config, cloud }: Deps): Router {
  const r = Router();
  const forBooth = and(eq(schema.packages.active, true), eq(schema.packages.country, config.country));
  const P = schema.photos;
  const offered = (method: string) => (COUNTRIES[config.country].momo as readonly string[]).includes(method);
  /** Sticky: a kiosk that reconnects mid-payment gets the QR again, and an empty value clears it. */
  const showOnKiosk = (pay: { url: string; amountXof: number } | null) => hub.sticky('kiosk.payment', pay, ['kiosk']);
  const announcePaid = (orderId: string, bookingId: string) => {
    printQueue.kick();
    showOnKiosk(null);
    hub.send('order.paid', { orderId, bookingId });
  };

  // ─── Mobile Money through the cloud (CinetPay / FedaPay / MTN) ───
  const needCloud = () => { if (!cloud) throw new HttpError(503, 'cloud_not_configured'); return cloud; };
  const cloudFail = (e: unknown): never => {
    if (e instanceof CloudError) throw new HttpError(e.status === 0 ? 503 : 502, e.code);
    throw e;
  };
  type Verdict = { status: string; operatorRef?: string | null; operatorMismatch?: boolean };

  /**
   * Mirrors the cloud's verdict on one Mobile Money payment. A success fulfils the order exactly once,
   * whoever sees it first (this poll, the verify button, or the background sync).
   */
  async function followCloud(paymentId: string, actor: StaffUser, ask: () => Promise<Verdict>) {
    const local = db.select().from(schema.payments).where(eq(schema.payments.id, paymentId)).get();
    const order = local && db.select().from(schema.orders).where(eq(schema.orders.id, local.orderId)).get();
    if (!local || !order || order.boothId !== boothId) throw new HttpError(404, 'payment_not_found');
    if (local.status !== 'pending') return { status: local.status as string, operatorRef: local.providerTxId, operatorMismatch: false };

    let v: Verdict;
    try {
      v = await ask();
    } catch (e) {
      if (!(e instanceof CloudError) || e.status !== 404) return cloudFail(e);
      // The cloud never received this payment (the request was lost on the way): nothing can be charged.
      v = { status: 'failed' };
    }
    const pendingOnly = and(eq(schema.payments.id, paymentId), eq(schema.payments.status, 'pending'));
    if (v.status === 'succeeded') {
      const now = Date.now();
      const outcome = db.transaction((tx) => {
        if (!tx.update(schema.payments).set({ status: 'succeeded', confirmedAt: now }).where(pendingOnly).run().changes) return 'already';
        if (v.operatorRef) recordOperatorRef(tx, paymentId, v.operatorRef);
        return fulfilOrder(tx, order.id, boothId, now) ? 'fulfilled' : 'unmatched';
      });
      if (outcome === 'fulfilled') {
        audit(db, boothId, { action: 'payment.momo_confirmed', actorId: actor.id, actorRole: actor.role, entity: 'payment', entityId: paymentId, data: { operatorRef: v.operatorRef ?? null } });
        announcePaid(order.id, order.bookingId);
      } else if (outcome === 'unmatched') {
        // Paid, but the order was already settled another way or replaced: the amount stays as credit on the booking.
        audit(db, boothId, { action: 'payment.unmatched', actorId: actor.id, actorRole: actor.role, entity: 'payment', entityId: paymentId, data: { amountXof: local.amountXof, orderId: order.id } });
        announcePaid(order.id, order.bookingId);
      }
    } else if (v.status === 'failed') {
      if (db.update(schema.payments).set({ status: 'failed' }).where(pendingOnly).run().changes) showOnKiosk(null);
    }
    return { status: v.status, operatorRef: v.operatorRef ?? null, operatorMismatch: v.operatorMismatch ?? false };
  }

  /**
   * Before money is taken another way, or the cart is rebuilt: ask about Mobile Money payments still
   * pending for this family, so a customer who just paid on the phone is never charged twice.
   * Offline, the check is skipped after a short wait (cash must always work).
   */
  async function settlePending(bookingId: string, actor: StaffUser): Promise<void> {
    if (!cloud) return;
    const pending = db.select({ id: schema.payments.id }).from(schema.payments)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.payments.orderId))
      .where(and(eq(schema.orders.bookingId, bookingId), eq(schema.payments.status, 'pending')))
      .orderBy(desc(schema.payments.createdAt)).limit(3).all();
    for (const p of pending) {
      await followCloud(p.id, actor, () => cloud.post(`/api/sync/payments/${p.id}/verify`, {}, QUICK_CHECK_MS)).catch(() => {});
    }
  }

  r.get('/api/pos/packages', requirePerm('payment.take'), (_req, res) => {
    res.json(db.select().from(schema.packages).where(forBooth).orderBy(schema.packages.sort).all());
  });

  // Families whose shoot is finished and who have not paid yet.
  r.get('/api/pos/families', requirePerm('payment.take'), (_req, res) => {
    const photoCount = sql<number>`(select count(*) from photos p where p.booking_id = ${schema.bookings.id} and p.ingest_status = 'ready' and p.hidden = 0)`;
    const favCount = sql<number>`(select count(*) from photos p where p.booking_id = ${schema.bookings.id} and p.ingest_status = 'ready' and p.hidden = 0 and p.favorite = 1)`;
    res.json(db.select({
      bookingId: schema.bookings.id, bookingCode: schema.bookings.code, familyName: schema.customers.fullName,
      partySize: schema.bookings.partySize, photoCount, favCount, updatedAt: schema.bookings.updatedAt,
    }).from(schema.bookings).innerJoin(schema.customers, eq(schema.customers.id, schema.bookings.customerId))
      .where(and(eq(schema.bookings.boothId, boothId), eq(schema.bookings.status, 'shot_complete')))
      .orderBy(schema.bookings.updatedAt).all()
      .map((f) => { const p = prepaidCredit(db, f.bookingId); return { ...f, prepaidXof: p.creditXof, prepaidPackageId: p.packageId }; }));
  });

  r.get('/api/pos/families/:bookingId/photos', requirePerm('payment.take'), (req, res) => {
    res.json(db.select().from(P)
      .where(and(eq(P.bookingId, String(req.params.bookingId)), eq(P.ingestStatus, 'ready'), eq(P.hidden, false)))
      .orderBy(P.takenAt, P.seq).all().map(toDto));
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

  r.post('/api/pos/orders', requirePerm('payment.take'), async (req, res) => {
    const body = NewOrder.parse(req.body);
    const user = staffOf(req);
    const known = db.select().from(schema.bookings).where(eq(schema.bookings.id, body.bookingId)).get();
    if (!known || known.boothId !== boothId) throw new HttpError(404, 'booking_not_found');
    await settlePending(known.id, user); // the previous cart may just have been paid on the phone

    const pkgs = new Map<string, Pkg & { code: string }>(db.select().from(schema.packages).where(forBooth).all().map((p) => [p.id, p]));
    const photoIds = new Set(db.select({ id: P.id }).from(P)
      .where(and(eq(P.bookingId, known.id), eq(P.ingestStatus, 'ready'), eq(P.hidden, false))).all().map((p) => p.id));
    const rate = vatBp(db);
    let priced: ReturnType<typeof priceCart>;
    try { priced = priceCart(pkgs, body, rate, photoIds); } catch (e) { throw new HttpError(400, (e as Error).message); }

    const order = db.transaction((tx) => {
      const booking = tx.select().from(schema.bookings).where(eq(schema.bookings.id, known.id)).get()!;
      if (booking.status !== 'shot_complete') throw new HttpError(409, `booking_${booking.status}`);
      // One open booth order per family: rebuilding the cart replaces it. Online orders (a gallery purchase
      // being paid right now) are the cloud's and are never touched here.
      for (const o of tx.select({ id: schema.orders.id }).from(schema.orders)
        .where(and(eq(schema.orders.bookingId, booking.id), eq(schema.orders.status, 'open'), eq(schema.orders.channel, 'booth'))).all()) {
        writeSynced(tx, schema.orders, { id: o.id, status: 'void' });
      }
      // A family who already paid (online, or a payment that landed late) only pays the difference.
      const credit = Math.min(prepaidCredit(tx, booking.id).creditXof, priced.subtotalXof);
      const total = priced.subtotalXof - credit;
      const o = writeSynced(tx, schema.orders, {
        id: uuidv7(), bookingId: booking.id, boothId, channel: 'booth', cashierId: user.id, status: 'open',
        subtotalXof: priced.subtotalXof, creditAppliedXof: credit, totalXof: total, vatBp: rate,
        vatXof: Math.round((total * rate) / (10_000 + rate)),
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

  r.post('/api/pos/orders/:id/pay', requirePerm('payment.take'), async (req, res) => {
    const body = Pay.parse(req.body);
    const user = staffOf(req);
    const known = db.select().from(schema.orders).where(eq(schema.orders.id, String(req.params.id))).get();
    if (!known || known.boothId !== boothId) throw new HttpError(404, 'order_not_found');
    if (body.method !== 'cash' && body.method !== 'prepaid' && !offered(body.method)) throw new HttpError(400, 'method_not_offered');
    await settlePending(known.bookingId, user); // a phone payment for this order may have gone through meanwhile

    const now = Date.now();
    const result = db.transaction((tx) => {
      const order = tx.select().from(schema.orders).where(eq(schema.orders.id, known.id)).get()!;
      if (order.status !== 'open') throw new HttpError(409, `order_${order.status}`); // also stops double taps
      if (body.method === 'prepaid') {
        if (order.totalXof !== 0) throw new HttpError(409, 'not_fully_prepaid');
        fulfilOrder(tx, order.id, boothId, now);
        return { order, payment: null, change: 0 };
      }
      if (order.totalXof === 0) throw new HttpError(409, 'nothing_to_pay');
      let drawerId: string | null = null;
      if (body.method === 'cash') {
        const drawer = openDrawer(tx as unknown as Db, boothId);
        if (!drawer) throw new HttpError(409, 'drawer_closed');
        if (body.tenderedXof < order.totalXof) throw new HttpError(400, 'tendered_too_low');
        drawerId = drawer.id;
      } else {
        const dup = tx.select({ id: schema.payments.id }).from(schema.payments)
          .where(and(eq(schema.payments.method, body.method), eq(schema.payments.providerTxId, body.reference))).get();
        if (dup) throw new HttpError(409, 'reference_already_used');
      }
      const payment = writeSynced(tx, schema.payments, {
        id: uuidv7(), orderId: order.id, method: body.method, idempotencyKey: uuidv7(),
        // Manual entry: the cashier confirms from the customer's receipt (offline fallback).
        provider: body.method === 'cash' ? null : 'manual',
        providerTxId: body.method === 'cash' ? null : body.reference,
        payerPhone: body.method === 'cash' ? null : body.payerPhone ?? null,
        amountXof: order.totalXof, status: 'succeeded', receivedBy: user.id, drawerSessionId: drawerId, confirmedAt: now,
      });
      if (drawerId) {
        writeSynced(tx, schema.cashMovements, { id: uuidv7(), drawerSessionId: drawerId, kind: 'sale', amountXof: order.totalXof, paymentId: payment.id, byUser: user.id });
      }
      fulfilOrder(tx, order.id, boothId, now);
      return { order, payment, change: body.method === 'cash' ? body.tenderedXof - order.totalXof : 0 };
    });
    audit(db, boothId, {
      action: 'payment.take', actorId: user.id, actorRole: user.role, entity: result.payment ? 'payment' : 'order',
      entityId: result.payment?.id ?? result.order.id,
      data: { method: body.method, amount: result.payment?.amountXof ?? 0, reference: result.payment?.providerTxId ?? null },
    });
    announcePaid(result.order.id, result.order.bookingId);
    res.json({ paymentId: result.payment?.id ?? null, changeXof: result.change });
  });

  r.post('/api/pos/orders/:id/momo', requirePerm('payment.take'), async (req, res) => {
    const c = needCloud();
    const body = CloudPay.parse(req.body);
    const user = staffOf(req);
    const known = db.select().from(schema.orders).where(eq(schema.orders.id, String(req.params.id))).get();
    if (!known || known.boothId !== boothId) throw new HttpError(404, 'order_not_found');
    if (!offered(body.method)) throw new HttpError(400, 'method_not_offered');
    await settlePending(known.bookingId, user); // an earlier attempt may have succeeded: never start a second charge blind

    const order = db.select().from(schema.orders).where(eq(schema.orders.id, known.id)).get()!;
    if (order.status !== 'open') throw new HttpError(409, `order_${order.status}`);
    if (order.totalXof === 0) throw new HttpError(409, 'nothing_to_pay');
    const items = db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, order.id)).all();
    const paymentId = uuidv7();
    // Written BEFORE the network call: if the answer is lost, the payment is still tracked and polled,
    // instead of the cashier retrying and the customer getting two prompts.
    // Cloud-owned row (never in the outbox): only the cloud's verdict settles it.
    db.insert(schema.payments).values({
      id: paymentId, orderId: order.id, method: body.method, provider: null, idempotencyKey: paymentId,
      amountXof: order.totalXof, payerPhone: body.phone ?? null, status: 'pending', receivedBy: user.id,
    }).run();
    audit(db, boothId, { action: 'payment.momo_start', actorId: user.id, actorRole: user.role, entity: 'payment', entityId: paymentId, data: { method: body.method } });

    let started: { kind: 'redirect' | 'push'; url?: string; provider: string };
    try {
      // The order travels with the request: the outbox may not have pushed it yet.
      started = await c.post('/api/sync/payments', { order, items, paymentId, method: body.method, phone: body.phone, receivedBy: user.id });
    } catch (e) {
      const unknown = e instanceof CloudError && (e.status === 0 || e.code === 'internal' || e.code.startsWith('http_'));
      if (unknown) return res.status(202).json({ paymentId, kind: 'unknown', url: null }); // polling finds out what happened
      db.update(schema.payments).set({ status: 'failed' }).where(eq(schema.payments.id, paymentId)).run();
      return cloudFail(e);
    }
    const provider = CLOUD_PROVIDERS.find((p) => p === started.provider) ?? null;
    db.update(schema.payments).set({ provider }).where(eq(schema.payments.id, paymentId)).run();
    if (started.kind === 'redirect' && started.url) showOnKiosk({ url: started.url, amountXof: order.totalXof });
    res.status(201).json({ paymentId, kind: started.kind, url: started.url ?? null });
  });

  r.get('/api/pos/payments/:id', requirePerm('payment.take'), async (req, res) => {
    const c = needCloud();
    const id = String(req.params.id);
    res.json(await followCloud(id, staffOf(req), () => c.get(`/api/sync/payments/${id}`)));
  });

  // Webhook late? The cashier asks the provider directly (optionally with the id from the customer's SMS).
  r.post('/api/pos/payments/:id/verify', requirePerm('payment.take'), async (req, res) => {
    const c = needCloud();
    const id = String(req.params.id);
    const { operatorRef } = Verify.parse(req.body);
    const user = staffOf(req);
    audit(db, boothId, { action: 'payment.verify', actorId: user.id, actorRole: user.role, entity: 'payment', entityId: id, data: { operatorRef: operatorRef ?? null } });
    res.json(await followCloud(id, user, () => c.post(`/api/sync/payments/${id}/verify`, { operatorRef })));
  });

  r.post('/api/pos/kiosk-payment/clear', requirePerm('payment.take'), (_req, res) => { showOnKiosk(null); res.json({ ok: true }); });

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
