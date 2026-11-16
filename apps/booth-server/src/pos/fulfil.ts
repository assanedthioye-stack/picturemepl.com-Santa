import { and, eq } from 'drizzle-orm';
import { schema, writeSynced, type Db } from '@pmp/db';
import { enqueueUpload } from '../cloud/uploads';
import { uuidv7 } from '../ids';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Order = typeof schema.orders.$inferSelect;

/**
 * Money this family has paid that no booth sale has used yet.
 *   received = every succeeded payment on the booking's orders (online prepayment, cash, Mobile Money,
 *              and payments that landed on an order already void or already paid another way)
 *   consumed = goods handed over at the booth (subtotal of paid booth orders)
 * Online gallery purchases are left out: they are paid and consumed by themselves.
 */
export function prepaidCredit(db: Db | Tx, bookingId: string): { creditXof: number; packageId: string | null } {
  let received = 0;
  let consumed = 0;
  let packageId: string | null = null;
  for (const o of db.select().from(schema.orders).where(eq(schema.orders.bookingId, bookingId)).all()) {
    const bundle = db.select({ packageId: schema.orderItems.packageId }).from(schema.orderItems)
      .where(and(eq(schema.orderItems.orderId, o.id), eq(schema.orderItems.kind, 'bundle'))).get();
    if (o.channel === 'online' && !bundle) continue; // gallery purchase
    for (const p of db.select({ amountXof: schema.payments.amountXof }).from(schema.payments)
      .where(and(eq(schema.payments.orderId, o.id), eq(schema.payments.status, 'succeeded'))).all()) received += p.amountXof;
    if (o.channel === 'booth' && o.status === 'paid') consumed += o.subtotalXof;
    if (o.channel === 'online' && o.status === 'paid' && bundle) packageId = bundle.packageId; // pre-selects the cart
  }
  return { creditXof: Math.max(0, received - consumed), packageId };
}

/**
 * What a paid booth order sets in motion: booking completed, one print job per print line,
 * purchased originals at the front of the upload queue. Safe to call again (crash, pull + poll racing):
 * a print line that already has a job never gets a second one.
 */
export function deliverOrder(tx: Tx, order: Order, boothId: string): void {
  writeSynced(tx, schema.bookings, { id: order.bookingId, status: 'completed' });
  const items = tx.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, order.id)).all();
  for (const it of items) {
    if (it.kind === 'print' && it.photoId && it.printSize) {
      const has = tx.select({ id: schema.printJobs.id }).from(schema.printJobs).where(eq(schema.printJobs.orderItemId, it.id)).get();
      if (!has) {
        writeSynced(tx, schema.printJobs, {
          id: uuidv7(), boothId, orderItemId: it.id, photoId: it.photoId, printSize: it.printSize,
          copies: it.qty, status: 'queued', requestedBy: order.cashierId,
        });
      }
    } else if (it.kind === 'digital' && it.photoId) {
      enqueueUpload(tx as unknown as Db, it.photoId, 'deliverable', 10);
    }
  }
}

/** Marks an open order paid and delivers it. Returns false (and does nothing) when it is no longer open. */
export function fulfilOrder(tx: Tx, orderId: string, boothId: string, now: number): boolean {
  const order = tx.select().from(schema.orders).where(eq(schema.orders.id, orderId)).get();
  if (!order || order.status !== 'open') return false;
  writeSynced(tx, schema.orders, { id: order.id, status: 'paid', paidAt: now });
  deliverOrder(tx, order, boothId);
  return true;
}

/**
 * Remembers the operator's transaction id on a confirmed Mobile Money payment, so the same receipt
 * cannot be typed in again for another sale. Skipped when another payment already carries it.
 */
export function recordOperatorRef(tx: Tx, paymentId: string, ref: string): boolean {
  const p = tx.select().from(schema.payments).where(eq(schema.payments.id, paymentId)).get();
  if (!p || p.providerTxId) return false;
  const clash = tx.select({ id: schema.payments.id }).from(schema.payments)
    .where(and(eq(schema.payments.method, p.method), eq(schema.payments.providerTxId, ref))).get();
  if (clash) return false;
  tx.update(schema.payments).set({ providerTxId: ref }).where(eq(schema.payments.id, paymentId)).run();
  return true;
}
