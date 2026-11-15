import type { Q } from './db';
import { STATUS_RANK } from '@pmp/shared';
import { snake } from './util';

/** Status ranks: a sync can only move a row forward (a replayed or late push never undoes a payment). */
const RANK: Record<string, readonly string[]> = { bookings: STATUS_RANK.bookings, orders: STATUS_RANK.orders };

interface TableRule {
  /** Columns the booth may change on an existing row (all insertable ones when omitted). */
  update?: string[];
  /** Rows carry booth_id and must belong to the pushing booth. */
  boothScoped?: boolean;
}
export const SYNC_TABLES: Record<string, TableRule> = {
  customers: { update: ['full_name', 'email', 'locale', 'whatsapp_opt_in', 'updated_at', 'deleted_at'] },
  // Online bookings: code, PIN, slot and package belong to the cloud; the booth moves the status along.
  bookings: { boothScoped: true, update: ['status', 'checked_in_at', 'checked_in_by', 'party_size', 'notes', 'updated_at', 'deleted_at'] },
  photo_sessions: { boothScoped: true },
  photos: {},
  orders: { boothScoped: true },
  order_items: {},
  payments: {},
  drawer_sessions: { boothScoped: true },
  cash_movements: {},
};
/** Set by the cloud only (uploads, provider checks). */
const CLOUD_ONLY = new Set(['server_seq', 'preview_key', 'thumb_key', 'deliverable_key', 'upload_status', 'provider_ref', 'operator_ref', 'provider_data', 'last_checked_at']);
const REAL_PROVIDERS = ['cinetpay', 'fedapay', 'mtn'];

const columnCache = new Map<string, Set<string>>();
async function columns(q: Q, table: string): Promise<Set<string>> {
  let c = columnCache.get(table);
  if (!c) {
    c = new Set((await q.query<{ column_name: string }>(
      'select column_name from information_schema.columns where table_schema = current_schema() and table_name = $1', [table])).map((r) => r.column_name));
    columnCache.set(table, c);
  }
  return c;
}

/**
 * Upserts one booth row (camelCase, as the booth's outbox stores it).
 * Returns false when the row was refused (wrong booth, forged provider payment, unknown table).
 */
export async function applyBoothRow(q: Q, boothId: string, table: string, row: Record<string, unknown>): Promise<boolean> {
  const rule = SYNC_TABLES[table];
  if (!rule) return false;
  const cols = await columns(q, table);
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    const c = snake(k);
    if (cols.has(c) && !CLOUD_ONLY.has(c)) data[c] = v;
  }
  if (typeof data.id !== 'string') return false;
  if (rule.boothScoped && data.booth_id !== boothId) return false;
  // Provider payments are created and settled by the cloud alone.
  if (table === 'payments' && REAL_PROVIDERS.includes(String(data.provider))) return false;

  const names = Object.keys(data);
  const updatable = names.filter((n) => n !== 'id' && (!rule.update || rule.update.includes(n)));
  const rank = RANK[table];
  const r = `$${names.length + 1}::text[]`;
  const sets = updatable.map((n) => n === 'status' && rank
    ? `status = case when array_position(${r}, excluded.status) >= array_position(${r}, ${table}.status) then excluded.status else ${table}.status end`
    : `${n} = excluded.${n}`);
  const params: unknown[] = names.map((n) => data[n]);
  if (rank && sets.some((s) => s.startsWith('status ='))) params.push(rank);
  // Never let a booth touch a payment the cloud settled with a provider.
  const guard = table === 'payments' ? ` where ${table}.provider is null or ${table}.provider = 'manual'` : '';
  await q.query(
    `insert into ${table} (${names.join(', ')}) values (${names.map((_, i) => `$${i + 1}`).join(', ')})
     on conflict (id) do ${sets.length ? `update set ${sets.join(', ')}${guard}` : 'nothing'}`,
    params,
  );
  return true;
}

/** Everything the booth must know that changed since its cursor (its own pushes echo back harmlessly). */
export async function pullForBooth(q: Q, boothId: string, since: number) {
  // shortcut: no paging — one booth's daily volume is small; add LIMIT + per-table cursors if a pull ever exceeds a few thousand rows
  const [bookings, customers, orders, orderItems, payments] = await Promise.all([
    q.query('select * from bookings where booth_id = $1 and server_seq > $2', [boothId, since]),
    q.query('select c.* from customers c where c.server_seq > $2 and exists (select 1 from bookings b where b.customer_id = c.id and b.booth_id = $1)', [boothId, since]),
    q.query('select * from orders where booth_id = $1 and server_seq > $2', [boothId, since]),
    q.query('select i.* from order_items i join orders o on o.id = i.order_id where o.booth_id = $1 and i.server_seq > $2', [boothId, since]),
    q.query(`select p.id, p.order_id, p.method, p.provider, p.idempotency_key, p.provider_tx_id, p.amount_xof, p.payer_phone, p.status,
               p.received_by, p.drawer_session_id, p.confirmed_at, p.created_at, p.updated_at, p.deleted_at, p.server_seq, p.operator_ref
             from payments p join orders o on o.id = p.order_id where o.booth_id = $1 and p.server_seq > $2`, [boothId, since]),
  ]);
  const all = { bookings, customers, orders, order_items: orderItems, payments };
  const cursor = Math.max(since, ...Object.values(all).flat().map((r) => Number((r as { server_seq: number }).server_seq)));
  return { rows: all, cursor };
}
