import { COUNTRIES } from '@pmp/shared';
import type { Db, Q } from '../db';
import { newId } from '../util';
import type { InitResult, Method, Provider, ProviderId } from './types';

export class PayError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface PaymentsConfig {
  providers: Partial<Record<ProviderId, Provider>>;
  /** Which provider takes Wave/Orange Money in SN and CI, and MTN MoMo in BJ. */
  route: { SN: ProviderId; CI: ProviderId; BJ: ProviderId };
  apiUrl: string;
  /** Display only: numbers customers pay to when the cashier falls back to manual entry. */
  merchant: Partial<Record<Method, string>>;
}

const CHECK_EVERY_MS = 10_000;

export function providerFor(cfg: PaymentsConfig, country: 'SN' | 'BJ' | 'CI', method: Method): Provider {
  if (!(COUNTRIES[country].momo as readonly string[]).includes(method)) throw new PayError(400, 'method_not_offered');
  if (method === 'celtiis_cash') throw new PayError(400, 'method_not_integrated'); // no API yet: booth manual entry only
  const p = cfg.providers[cfg.route[country]];
  if (!p) throw new PayError(503, 'provider_not_configured');
  return p;
}

export interface StartInput {
  orderId: string;
  method: Method;
  country: 'SN' | 'BJ' | 'CI';
  phone?: string;
  customerName?: string;
  description: string;
  returnUrl: string;
  /** The booth chooses the payment id so it can keep a local row before the network answers. */
  paymentId?: string;
  receivedBy?: string | null;
}

/** Creates the pending payment for the order's total and asks the provider to collect it. */
export async function startPayment(db: Db, cfg: PaymentsConfig, i: StartInput): Promise<InitResult & { paymentId: string; provider: ProviderId }> {
  const provider = providerFor(cfg, i.country, i.method);
  const [order] = await db.query<{ total_xof: number; status: string }>('select total_xof, status from orders where id = $1', [i.orderId]);
  if (!order) throw new PayError(404, 'order_not_found');
  if (order.status !== 'open') throw new PayError(409, `order_${order.status}`);
  if (order.total_xof <= 0) throw new PayError(409, 'nothing_to_pay');
  const id = i.paymentId ?? newId();
  const now = Date.now();
  await db.query(
    `insert into payments (id, order_id, method, provider, idempotency_key, amount_xof, payer_phone, status, received_by, created_at, updated_at)
     values ($1, $2, $3, $4, $1, $5, $6, 'pending', $7, $8, $8)`,
    [id, i.orderId, i.method, provider.id, order.total_xof, i.phone ?? null, i.receivedBy ?? null, now],
  );
  try {
    const r = await provider.init({
      paymentId: id, amountXof: order.total_xof, method: i.method, country: i.country, phone: i.phone,
      customerName: i.customerName, description: i.description, returnUrl: i.returnUrl,
      notifyUrl: `${cfg.apiUrl}/api/webhooks/${provider.id}`,
    });
    await db.query('update payments set provider_ref = $2, updated_at = $3 where id = $1', [id, r.providerRef, Date.now()]);
    return { ...r, paymentId: id, provider: provider.id };
  } catch (e) {
    await db.query(`update payments set status = 'failed', provider_data = $2, updated_at = $3 where id = $1`,
      [id, JSON.stringify({ error: String((e as Error).message ?? e) }), Date.now()]);
    if (e instanceof PayError) throw e;
    console.error('provider init failed', e);
    throw new PayError(502, 'provider_error');
  }
}

export interface PaymentRow {
  id: string; order_id: string; status: 'pending' | 'succeeded' | 'failed' | 'cancelled'; provider: ProviderId | null;
  provider_ref: string | null; operator_ref: string | null; amount_xof: number; last_checked_at: number | null; method: string;
}

/**
 * Asks the provider for the real status (at most every 10 s unless forced) and settles the payment.
 * Webhooks, customer polling and the cashier's "verify" button all end here.
 */
export async function refreshPayment(db: Db, cfg: PaymentsConfig, paymentId: string, o: { force?: boolean } = {}): Promise<PaymentRow> {
  const [p] = await db.query<PaymentRow>('select * from payments where id = $1', [paymentId]);
  if (!p) throw new PayError(404, 'payment_not_found');
  if (p.status !== 'pending' || !p.provider || !p.provider_ref) return p;
  if (!o.force && p.last_checked_at && Date.now() - p.last_checked_at < CHECK_EVERY_MS) return p;
  const provider = cfg.providers[p.provider];
  if (!provider) return p;

  const r = await provider.check(p.id, p.provider_ref);
  const now = Date.now();
  let status = r.status;
  let note: string | undefined;
  // The sandbox charges EUR with the same number; elsewhere an amount mismatch is never accepted.
  if (status === 'succeeded' && r.amountXof !== undefined && r.amountXof !== p.amount_xof) { status = 'pending'; note = 'amount_mismatch'; }
  await db.tx(async (t) => {
    const changed = await t.query<{ id: string }>(
      `update payments set status = $2, operator_ref = coalesce($3, operator_ref), provider_data = $4, last_checked_at = $5,
         confirmed_at = case when $2 = 'succeeded' then $5 else confirmed_at end, updated_at = $5
       where id = $1 and status = 'pending' returning id`,
      [p.id, status, r.operatorRef ?? null, JSON.stringify(note ? { note, raw: r.raw } : r.raw ?? null), now],
    );
    if (changed.length && status === 'succeeded') await settleOrder(t, p.order_id, now);
  });
  const [after] = await db.query<PaymentRow>('select * from payments where id = $1', [paymentId]);
  return after!;
}

/** Paid order → booking confirmed (online package) — runs once, inside the payment's transaction. */
async function settleOrder(t: Q, orderId: string, now: number): Promise<void> {
  const [o] = await t.query<{ booking_id: string }>(
    `update orders set status = 'paid', paid_at = $2, updated_at = $2 where id = $1 and status = 'open' returning booking_id`, [orderId, now]);
  if (!o) return;
  // A late payment after the 15-minute hold still confirms: the money is taken, so the slot is honoured.
  await t.query(
    `update bookings set status = 'confirmed', hold_expires_at = null, updated_at = $2
     where id = $1 and status = 'pending_payment'
       and exists (select 1 from order_items where order_id = $3 and kind = 'bundle')`,
    [o.booking_id, now, orderId]);
}
