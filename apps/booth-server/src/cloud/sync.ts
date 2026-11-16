import { readFileSync } from 'node:fs';
import path from 'node:path';
import { and, asc, count, desc, eq, inArray, lt } from 'drizzle-orm';
import sharp from 'sharp';
import { getSetting, schema, setSetting, type Db } from '@pmp/db';
import { furthest } from '@pmp/shared';
import { previewPath, sessionDir } from '../photos/ingest';
import { deliverOrder, recordOperatorRef } from '../pos/fulfil';
import { CloudError, type CloudClient } from './client';
import { enqueueUpload, SKIPPED_HIDDEN } from './uploads';

/** Tables the cloud keeps (orders, payments, photos… for the gallery and reports). Others stay on the booth. */
const PUSHED = new Set(['customers', 'bookings', 'photo_sessions', 'photos', 'orders', 'order_items', 'payments', 'drawer_sessions', 'cash_movements']);
const MAX_ATTEMPTS = 3;

/**
 * How a pulled row lands on the booth.
 *  update: cloud-owned fields a pull may change on a row the booth already has (statuses only move forward);
 *  refs:   optional links to booth-local rows — cleared when the target is missing (e.g. after the booth
 *          PC was replaced), so one dangling reference can never block the whole sync.
 */
const PULLED = {
  customers: { table: schema.customers, update: [], rank: null, refs: [] },
  bookings: { table: schema.bookings, update: ['holdExpiresAt'], rank: 'bookings', refs: [['checkedInBy', schema.users]] },
  orders: { table: schema.orders, update: ['paidAt'], rank: 'orders', refs: [['cashierId', schema.users]] },
  order_items: { table: schema.orderItems, update: [], rank: null, refs: [['photoId', schema.photos]] },
  payments: { table: schema.payments, update: ['confirmedAt'], rank: 'payments', refs: [['receivedBy', schema.users], ['drawerSessionId', schema.drawerSessions]] },
} as const;
type PulledTable = keyof typeof PULLED;
/** Parents first so the booth's foreign keys hold. */
const PULL_ORDER: PulledTable[] = ['customers', 'bookings', 'orders', 'order_items', 'payments'];

const camelize = (row: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), v]));

export interface Applied { inserted: boolean; before: string | null; after: string | null }

/** Applies one cloud row without touching the outbox (no echo back to the cloud). */
export function applyPulled(db: Db, tbl: PulledTable, raw: Record<string, unknown>): Applied {
  const { table, update, rank, refs } = PULLED[tbl];
  const row = camelize(raw) as Record<string, any>;
  const t = table as any;
  const existing = db.select().from(t).where(eq(t.id, row.id)).get() as Record<string, any> | undefined;
  if (!existing) {
    for (const [col, parent] of refs) {
      const p = parent as any;
      if (row[col] != null && !db.select({ id: p.id }).from(p).where(eq(p.id, row[col])).get()) row[col] = null;
    }
    db.insert(t).values(row).run(); // drizzle keeps only the booth's columns
    return { inserted: true, before: null, after: row.status ?? null };
  }
  const set: Record<string, unknown> = {};
  for (const k of update) if (row[k] !== undefined && row[k] !== existing[k]) set[k] = row[k];
  const after = rank && row.status ? furthest(rank, existing.status, row.status) : existing.status ?? null;
  if (after !== (existing.status ?? null)) set.status = after;
  if (Object.keys(set).length) db.update(t).set(set).where(eq(t.id, row.id)).run();
  return { inserted: false, before: existing.status ?? null, after };
}

export interface PullResult {
  /** Booth orders the cloud settled (Mobile Money confirmed while nobody was polling); already delivered. */
  paidOrders: Array<{ orderId: string; bookingId: string }>;
}
export interface SyncStatus { ok: boolean; lastError: string | null; lastOkAt: number | null; outbox: number; uploads: number }

/**
 * Booth ↔ cloud, every 15 s: push the outbox, pull online bookings/payments, upload photos.
 * Every step tolerates the network dropping and resumes on the next tick.
 */
export class CloudSync {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  lastError: string | null = null;
  private lastOkAt: number | null = null;

  constructor(private o: {
    db: Db; client: CloudClient; boothId: string; sessionsDir: string;
    onPulled?: (r: PullResult) => void;
    /** Called when the link goes down or comes back. */
    onStatus?: (s: SyncStatus) => void;
  }) {}

  start(everyMs = 15_000): void {
    // Jobs left "failed" by an earlier run get one fresh chance per start.
    this.o.db.update(schema.uploadJobs).set({ status: 'queued', attempts: 0 }).where(eq(schema.uploadJobs.status, 'failed')).run();
    void this.tick();
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  status(): SyncStatus {
    const { db } = this.o;
    return {
      ok: this.lastError === null,
      lastError: this.lastError,
      lastOkAt: this.lastOkAt,
      outbox: db.select({ n: count() }).from(schema.syncOutbox).where(lt(schema.syncOutbox.attempts, MAX_ATTEMPTS)).get()!.n,
      uploads: db.select({ n: count() }).from(schema.uploadJobs).where(eq(schema.uploadJobs.status, 'queued')).get()!.n,
    };
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const wasOk = this.lastError === null;
    try {
      await this.push();
      await this.pull();
      await this.uploads();
      if (this.lastError) console.log('cloud sync: back online');
      this.lastError = null;
      this.lastOkAt = Date.now();
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (msg !== this.lastError) console.error(`cloud sync: ${msg} (will retry)`); // once per outage, not every 15 s
      this.lastError = msg;
    } finally {
      this.running = false;
      if (wasOk !== (this.lastError === null)) this.o.onStatus?.(this.status());
    }
  }

  async push(): Promise<void> {
    const { db } = this.o;
    const O = schema.syncOutbox;
    for (let batch = 0; batch < 10; batch++) {
      const rows = db.select().from(O).where(lt(O.attempts, MAX_ATTEMPTS)).orderBy(asc(O.seq)).limit(200).all();
      if (!rows.length) return;
      const local = rows.filter((r) => !PUSHED.has(r.tbl));
      // shortcut: users, cameras, queue, print jobs, audit stay booth-only; push them when a cloud report needs them
      if (local.length) db.delete(O).where(inArray(O.seq, local.map((r) => r.seq))).run();
      const send = rows.filter((r) => PUSHED.has(r.tbl));
      if (send.length) {
        const { refused } = await this.o.client.post<{ refused: number[] }>('/api/sync/push', {
          rows: send.map((r) => ({ tbl: r.tbl, row: JSON.parse(r.payload) })),
        });
        const bad = new Set(refused.map((i) => send[i]!.seq));
        db.transaction((tx) => {
          const ok = send.filter((r) => !bad.has(r.seq)).map((r) => r.seq);
          if (ok.length) tx.delete(O).where(inArray(O.seq, ok)).run();
          // Refused rows stay for inspection; after 3 tries they stop blocking the queue.
          for (const r of send.filter((x) => bad.has(x.seq))) {
            tx.update(O).set({ attempts: r.attempts + 1, lastError: 'refused_by_cloud' }).where(eq(O.seq, r.seq)).run();
            if (r.attempts + 1 >= MAX_ATTEMPTS) console.error(`cloud sync: ${r.tbl} ${r.rowId} refused by the cloud, parked in sync_outbox`);
          }
        });
      }
      if (rows.length < 200) return;
    }
  }

  async pull(): Promise<void> {
    const { db, boothId } = this.o;
    const since = Number(getSetting(db, 'sync.cursor') ?? 0) || 0;
    const r = await this.o.client.get<{ rows: Partial<Record<PulledTable, Record<string, unknown>[]>>; cursor: number }>(`/api/sync/pull?since=${since}`);
    const paidOrders: PullResult['paidOrders'] = [];
    let changed = false;
    db.transaction((tx) => {
      const d = tx as unknown as Db;
      for (const tbl of PULL_ORDER) {
        for (const row of r.rows[tbl] ?? []) {
          try {
            // Own savepoint: a row the booth cannot store is logged and skipped, the rest still lands.
            tx.transaction((sp) => {
              const a = applyPulled(sp as unknown as Db, tbl, row);
              if (tbl === 'payments' && a.after === 'succeeded' && typeof row.operator_ref === 'string') {
                recordOperatorRef(sp, String(row.id), row.operator_ref);
              }
            });
            changed = true;
          } catch (e) {
            console.error(`cloud sync: could not store ${tbl} ${String(row.id)}: ${(e as Error).message}`);
          }
        }
      }
      for (const row of r.rows.orders ?? []) {
        const o = tx.select().from(schema.orders).where(eq(schema.orders.id, String(row.id))).get();
        if (!o || o.status !== 'paid') continue;
        if (o.channel === 'booth') {
          // Settled by the cloud while no cashier screen was polling: prints and completion happen here.
          const booking = tx.select({ status: schema.bookings.status }).from(schema.bookings).where(eq(schema.bookings.id, o.bookingId)).get();
          if (booking && booking.status !== 'completed') {
            deliverOrder(tx, o, boothId);
            paidOrders.push({ orderId: o.id, bookingId: o.bookingId });
          }
        } else {
          // Bought in the online gallery: those originals jump the upload queue.
          for (const it of tx.select().from(schema.orderItems).where(and(eq(schema.orderItems.orderId, o.id), eq(schema.orderItems.kind, 'digital'))).all()) {
            if (it.photoId) enqueueUpload(d, it.photoId, 'deliverable', 10);
          }
        }
      }
      setSetting(d, 'sync.cursor', String(r.cursor));
    });
    if (changed) this.o.onPulled?.({ paidOrders });
  }

  /**
   * Sends up to `max` photo files, most urgent first (purchased originals, then gallery previews).
   * Network trouble stops the round and is retried for ever; only a file that cannot be read or that the
   * cloud rejects outright is given up on.
   */
  async uploads(max = 20): Promise<number> {
    const { db, client, sessionsDir } = this.o;
    const U = schema.uploadJobs;
    const jobs = db.select().from(U).where(eq(U.status, 'queued'))
      .orderBy(desc(U.priority), asc(U.attempts), asc(U.createdAt)).limit(max).all();
    const close = (id: string, status: 'done' | 'failed', lastError: string | null) =>
      db.update(U).set({ status, lastError }).where(eq(U.id, id)).run();
    let done = 0;
    for (const job of jobs) {
      const photo = db.select().from(schema.photos).where(eq(schema.photos.id, job.photoId)).get();
      if (!photo || photo.hidden) { close(job.id, 'done', SKIPPED_HIDDEN); continue; }
      let body: Buffer;
      try {
        body = await renditionOf(job.kind, photo, sessionsDir);
      } catch (e) {
        close(job.id, 'failed', `unreadable: ${(e as Error).message}`);
        continue;
      }
      try {
        const target = await client.post<{ url: string; headers: Record<string, string> }>('/api/sync/upload-url', { photoId: photo.id, kind: job.kind });
        const put = await fetch(target.url, { method: 'PUT', headers: target.headers, body: body as unknown as BodyInit, signal: AbortSignal.timeout(120_000) })
          .catch(() => { throw new CloudError(0, 'upload_unreachable'); });
        if (!put.ok) throw new CloudError(put.status, `upload_http_${put.status}`);
        await client.post('/api/sync/uploaded', { photoId: photo.id, kind: job.kind });
        close(job.id, 'done', null);
        done++;
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        if (e instanceof CloudError && !e.transient) { close(job.id, 'failed', msg); continue; } // e.g. the cloud does not know this photo
        db.update(U).set({ attempts: job.attempts + 1, lastError: msg }).where(eq(U.id, job.id)).run();
        throw e; // the line is down: stop here, the next tick resumes
      }
    }
    return done;
  }
}

/**
 * Gallery files, sized for phones on mobile data: 400 px thumbnail (~25 KB) and 1024 px preview,
 * both from the watermarked preview; the download is a 3000 px JPEG of the untouched original.
 */
async function renditionOf(kind: string, photo: typeof schema.photos.$inferSelect, sessionsDir: string): Promise<Buffer> {
  if (kind === 'deliverable') {
    return sharp(readFileSync(path.join(sessionDir(sessionsDir, photo.sessionId), photo.fileName)), { failOn: 'none' })
      .rotate().resize(3000, 3000, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
  }
  const edge = kind === 'thumb' ? 400 : 1024;
  return sharp(readFileSync(previewPath(sessionsDir, photo)))
    .resize(edge, edge, { fit: 'inside', withoutEnlargement: true }).webp({ quality: kind === 'thumb' ? 60 : 72 }).toBuffer();
}
