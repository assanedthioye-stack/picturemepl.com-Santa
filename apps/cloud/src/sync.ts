import { STATUS_RANK } from '@pmp/shared';
import type { Q, Tx } from './db';
import { snake } from './util';

/** Status ranks: a sync can only move a row forward (a replayed or late push never undoes a payment). */
const RANK: Record<string, readonly string[]> = { bookings: STATUS_RANK.bookings, orders: STATUS_RANK.orders };

interface TableRule {
  /** Columns the booth may change on an existing row (all insertable ones when omitted). */
  update?: string[];
  /** Rows carry booth_id and must belong to the pushing booth. */
  boothScoped?: boolean;
  /** Child rows belong to the booth through this parent, which must exist and be the booth's. */
  parent?: { fk: string; table: string };
}
export const SYNC_TABLES: Record<string, TableRule> = {
  customers: { update: ['full_name', 'email', 'locale', 'whatsapp_opt_in', 'updated_at', 'deleted_at'] },
  // Online bookings: code, PIN, slot and package belong to the cloud; the booth moves the status along.
  bookings: { boothScoped: true, update: ['status', 'checked_in_at', 'checked_in_by', 'party_size', 'notes', 'updated_at', 'deleted_at'] },
  photo_sessions: { boothScoped: true },
  photos: { parent: { fk: 'booking_id', table: 'bookings' } },
  orders: { boothScoped: true },
  order_items: { parent: { fk: 'order_id', table: 'orders' } },
  payments: { parent: { fk: 'order_id', table: 'orders' } },
  drawer_sessions: { boothScoped: true },
  cash_movements: { parent: { fk: 'drawer_session_id', table: 'drawer_sessions' } },
};
/** Set by the cloud only (uploads, provider checks). */
const CLOUD_ONLY = new Set(['server_seq', 'preview_key', 'thumb_key', 'deliverable_key', 'upload_status', 'provider_ref', 'operator_ref', 'provider_data', 'last_checked_at']);

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
 * Returns false when the row was refused: unknown table, another booth's row or parent,
 * an online order, or a provider payment (those are settled by the cloud alone).
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
  if (table === 'orders' && data.channel !== 'booth') return false; // online orders belong to the cloud
  if (table === 'payments' && data.provider != null && data.provider !== 'manual') return false;
  if (rule.parent) {
    const [owned] = await q.query(`select 1 from ${rule.parent.table} where id = $1 and booth_id = $2`, [data[rule.parent.fk], boothId]);
    if (!owned) return false;
  }

  const names = Object.keys(data);
  const params: unknown[] = names.map((n) => data[n]);
  const p = (v: unknown) => `$${params.push(v)}`;
  const updatable = names.filter((n) => n !== 'id' && (!rule.update || rule.update.includes(n)));
  const rank = RANK[table];
  const sets = updatable.map((n) => {
    if (n !== 'status' || !rank) return `${n} = excluded.${n}`;
    const r = `${p(rank)}::text[]`;
    return `status = case when array_position(${r}, excluded.status) >= array_position(${r}, ${table}.status) then excluded.status else ${table}.status end`;
  });

  // What an existing row must satisfy before this booth may change it.
  const guards: string[] = [];
  if (rule.boothScoped) guards.push(`${table}.booth_id = ${p(boothId)}`);
  if (rule.parent) guards.push(`${table}.${rule.parent.fk} = excluded.${rule.parent.fk}`); // a row never moves to another parent
  if (table === 'orders') guards.push(`${table}.channel = 'booth'`);
  if (table === 'payments') guards.push(`(${table}.provider is null or ${table}.provider = 'manual')`);
  if (table === 'customers') guards.push(`not exists (select 1 from bookings b where b.customer_id = ${table}.id and b.booth_id <> ${p(boothId)})`);

  const insert = `insert into ${table} (${names.join(', ')}) values (${names.map((_, i) => `$${i + 1}`).join(', ')})`;
  if (!sets.length) {
    await q.query(`${insert} on conflict (id) do nothing`, params);
    return true;
  }
  const done = await q.query(
    `${insert} on conflict (id) do update set ${sets.join(', ')}${guards.length ? ` where ${guards.join(' and ')}` : ''} returning id`,
    params,
  );
  return done.length > 0; // 0 rows = an existing row this booth may not touch
}

/** applyBoothRow in its own savepoint: one bad row (constraint, bad type) is refused instead of failing the whole batch for ever. */
export async function applyBoothRowSafely(t: Tx, boothId: string, table: string, row: Record<string, unknown>): Promise<boolean> {
  try {
    return await t.savepoint((sp) => applyBoothRow(sp, boothId, table, row));
  } catch (e) {
    console.error(`sync: refused ${table} row ${String(row.id)}: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Everything the booth must know that changed since its cursor (its own pushes echo back harmlessly).
 * Must run inside ONE repeatable-read transaction: the five queries then share a snapshot, so the
 * cursor never moves past a row that another query in this pull did not see.
 */
export async function pullForBooth(q: Q, boothId: string, since: number) {
  // shortcut: no paging — one booth's daily volume is small; add LIMIT + per-table cursors if a pull ever exceeds a few thousand rows
  const bookings = await q.query('select * from bookings where booth_id = $1 and server_seq > $2', [boothId, since]);
  const customers = await q.query('select c.* from customers c where c.server_seq > $2 and exists (select 1 from bookings b where b.customer_id = c.id and b.booth_id = $1)', [boothId, since]);
  const orders = await q.query('select * from orders where booth_id = $1 and server_seq > $2', [boothId, since]);
  const orderItems = await q.query('select i.* from order_items i join orders o on o.id = i.order_id where o.booth_id = $1 and i.server_seq > $2', [boothId, since]);
  const payments = await q.query(
    `select p.id, p.order_id, p.method, p.provider, p.idempotency_key, p.provider_tx_id, p.amount_xof, p.payer_phone, p.status,
            p.received_by, p.drawer_session_id, p.confirmed_at, p.created_at, p.updated_at, p.deleted_at, p.server_seq, p.operator_ref
     from payments p join orders o on o.id = p.order_id where o.booth_id = $1 and p.server_seq > $2`, [boothId, since]);
  const all = { bookings, customers, orders, order_items: orderItems, payments };
  let cursor = since;
  for (const r of Object.values(all).flat()) cursor = Math.max(cursor, Number((r as { server_seq: number }).server_seq));
  return { rows: all, cursor };
}
