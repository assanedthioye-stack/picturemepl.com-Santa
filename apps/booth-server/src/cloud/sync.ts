import { readFileSync } from 'node:fs';
import path from 'node:path';
import { and, asc, desc, eq, inArray, lt } from 'drizzle-orm';
import sharp from 'sharp';
import { getSetting, schema, setSetting, type Db } from '@pmp/db';
import { furthest } from '@pmp/shared';
import { previewPath, sessionDir } from '../photos/ingest';
import type { CloudClient } from './client';

/** Tables the cloud keeps (orders, payments, photos… for the gallery and reports). Others stay on the booth. */
const PUSHED = new Set(['customers', 'bookings', 'photo_sessions', 'photos', 'orders', 'order_items', 'payments', 'drawer_sessions', 'cash_movements']);
const MAX_ATTEMPTS = 3;

/** What a pull may change on a row the booth already has: cloud-owned fields only; statuses only move forward. */
const PULLED = {
  bookings: { table: schema.bookings, update: ['holdExpiresAt'], rank: 'bookings' },
  customers: { table: schema.customers, update: [], rank: null },
  orders: { table: schema.orders, update: ['paidAt'], rank: 'orders' },
  order_items: { table: schema.orderItems, update: [], rank: null },
  payments: { table: schema.payments, update: ['confirmedAt'], rank: 'payments' },
} as const;

const camelize = (row: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), v]));

/** Applies cloud rows without touching the outbox (no echo back to the cloud). */
export function applyPulled(db: Db, tbl: keyof typeof PULLED, raw: Record<string, unknown>): void {
  const { table, update, rank } = PULLED[tbl];
  const row = camelize(raw) as Record<string, any>;
  const t = table as any;
  const existing = db.select().from(t).where(eq(t.id, row.id)).get() as Record<string, any> | undefined;
  if (!existing) {
    db.insert(t).values(row).run(); // drizzle keeps only the booth's columns
    return;
  }
  const set: Record<string, unknown> = {};
  for (const k of update) if (row[k] !== undefined) set[k] = row[k];
  if (rank && row.status) set.status = furthest(rank, existing.status, row.status);
  if (Object.keys(set).length) db.update(t).set(set).where(eq(t.id, row.id)).run();
}

/**
 * Booth ↔ cloud, every 15 s: push the outbox, pull online bookings/payments, upload photos.
 * Every step tolerates the network dropping and resumes on the next tick.
 */
export class CloudSync {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  lastError: string | null = null;

  constructor(private o: { db: Db; client: CloudClient; sessionsDir: string; onPulled?: () => void }) {}

  start(everyMs = 15_000): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.push();
      await this.pull();
      await this.uploads();
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
    } finally {
      this.running = false;
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
      if (!send.length) continue;
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
        }
      });
      if (rows.length < 200) return;
    }
  }

  async pull(): Promise<void> {
    const { db } = this.o;
    const since = Number(getSetting(db, 'sync.cursor') ?? 0);
    const r = await this.o.client.get<{ rows: Record<keyof typeof PULLED, Record<string, unknown>[]>; cursor: number }>(`/api/sync/pull?since=${since}`);
    let changed = false;
    db.transaction((tx) => {
      // Parents first so the booth's foreign keys hold.
      for (const tbl of ['customers', 'bookings', 'orders', 'order_items', 'payments'] as const) {
        for (const row of r.rows[tbl] ?? []) { applyPulled(tx as unknown as Db, tbl, row); changed = true; }
      }
      // Photos bought in the online gallery: their originals jump the upload queue.
      for (const it of r.rows.order_items ?? []) {
        if (it.kind !== 'digital' || !it.photo_id) continue;
        const order = tx.select({ status: schema.orders.status }).from(schema.orders).where(eq(schema.orders.id, String(it.order_id))).get();
        if (order?.status === 'paid') enqueueUpload(tx as unknown as Db, String(it.photo_id), 'deliverable', 10);
      }
      setSetting(tx as unknown as Db, 'sync.cursor', String(r.cursor));
    });
    if (changed) this.o.onPulled?.();
  }

  /** Sends up to `max` photo files, most urgent first (purchased originals, then gallery previews). */
  async uploads(max = 20): Promise<number> {
    const { db, client, sessionsDir } = this.o;
    const U = schema.uploadJobs;
    const jobs = db.select().from(U).where(and(inArray(U.status, ['queued', 'failed']), lt(U.attempts, 5)))
      .orderBy(desc(U.priority), asc(U.createdAt)).limit(max).all();
    let done = 0;
    for (const job of jobs) {
      try {
        const photo = db.select().from(schema.photos).where(eq(schema.photos.id, job.photoId)).get();
        if (!photo || photo.hidden) {
          db.update(U).set({ status: 'done', lastError: 'skipped_hidden' }).where(eq(U.id, job.id)).run();
          continue;
        }
        const body = await renditionOf(job.kind, photo, sessionsDir);
        const target = await client.post<{ url: string; headers: Record<string, string> }>('/api/sync/upload-url', { photoId: photo.id, kind: job.kind });
        const put = await fetch(target.url, { method: 'PUT', headers: target.headers, body: body as unknown as BodyInit, signal: AbortSignal.timeout(120_000) });
        if (!put.ok) throw new Error(`upload_http_${put.status}`);
        await client.post('/api/sync/uploaded', { photoId: photo.id, kind: job.kind });
        db.update(U).set({ status: 'done', lastError: null }).where(eq(U.id, job.id)).run();
        done++;
      } catch (e) {
        db.update(U).set({ status: 'failed', attempts: job.attempts + 1, lastError: (e as Error).message }).where(eq(U.id, job.id)).run();
      }
    }
    return done;
  }
}

export function enqueueUpload(db: Db, photoId: string, kind: 'thumb' | 'preview' | 'deliverable', priority: number): void {
  const U = schema.uploadJobs;
  const existing = db.select().from(U).where(and(eq(U.photoId, photoId), eq(U.kind, kind))).get();
  if (!existing) {
    db.insert(U).values({ id: crypto.randomUUID(), photoId, kind, priority, status: 'queued', createdAt: Date.now() }).run();
  } else if (existing.status !== 'done' && existing.priority < priority) {
    db.update(U).set({ priority }).where(eq(U.id, existing.id)).run();
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
