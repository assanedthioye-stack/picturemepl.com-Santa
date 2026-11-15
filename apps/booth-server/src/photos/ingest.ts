import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { and, eq, inArray, max, sql } from 'drizzle-orm';
import { schema, writeSynced, type Db } from '@pmp/db';
import type { EventHub } from '../events';
import { uuidv7 } from '../ids';
import { JPEG_EXT, RAW_EXT } from '../camera/types';
import { makePreview } from './preview';

export interface IngestCtx {
  db: Db;
  hub: EventHub;
  sessionsDir: string;
  watermark: string;
}

export type PhotoRow = typeof schema.photos.$inferSelect;
export interface PhotoDto { id: string; sessionId: string; seq: number; hidden: boolean; favorite: boolean; previewUrl: string }

export const sessionDir = (root: string, sessionId: string) => path.join(root, sessionId);
export const previewPath = (root: string, p: { sessionId: string; id: string }) =>
  path.join(root, p.sessionId, 'previews', `${p.id}.jpg`);

export function toDto(p: PhotoRow): PhotoDto {
  return { id: p.id, sessionId: p.sessionId, seq: p.seq, hidden: p.hidden, favorite: p.favorite, previewUrl: `/media/previews/${p.id}` };
}

/** First free path: IMG_0001.JPG, IMG_0001_1.JPG, … (EDSDK's downloadToFile overwrites, so this guards originals). */
export function uniquePath(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  for (let i = 0; ; i++) {
    const candidate = path.join(dir, i === 0 ? name : `${base}_${i}${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

const stem = (f: string) => path.basename(f, path.extname(f)).toLowerCase();

/**
 * Registers a file the camera just wrote into Sessions\{sessionId}\.
 * JPEG → photo row + watermarked preview. RAW → attached to the JPEG with the same name.
 */
export async function ingestFile(ctx: IngestCtx, file: string, originalName: string, sessionId: string): Promise<PhotoRow | null> {
  const { db, hub } = ctx;
  const fileName = path.basename(file);

  if (RAW_EXT.test(fileName)) {
    // RAW usually arrives before its JPEG; the JPEG branch also looks for it on disk.
    const jpeg = db.select().from(schema.photos).where(eq(schema.photos.sessionId, sessionId)).all()
      .find((p) => stem(p.fileName) === stem(fileName));
    if (jpeg) writeSynced(db, schema.photos, { id: jpeg.id, rawFileName: fileName });
    return null;
  }
  if (!JPEG_EXT.test(fileName)) return null; // movies etc. stay on disk, untracked

  const sha256 = await sha256File(file);
  const dup = db.select().from(schema.photos)
    .where(and(eq(schema.photos.sessionId, sessionId), eq(schema.photos.sha256, sha256))).get();
  if (dup) {
    unlinkSync(file); // same bytes re-sent by the camera
    return dup;
  }

  const session = db.select().from(schema.photoSessions).where(eq(schema.photoSessions.id, sessionId)).get();
  if (!session) throw new Error(`unknown session ${sessionId}`);

  const dir = path.dirname(file);
  const raw = readdirSync(dir).find((f) => RAW_EXT.test(f) && stem(f) === stem(fileName)) ?? null;

  const photo = db.transaction((tx) => {
    const next = (tx.select({ m: max(schema.photos.seq) }).from(schema.photos)
      .where(eq(schema.photos.sessionId, sessionId)).get()?.m ?? 0) + 1;
    return writeSynced(tx, schema.photos, {
      id: uuidv7(), sessionId, bookingId: session.bookingId, seq: next, originalName, fileName,
      rawFileName: raw, sha256, takenAt: Date.now(), ingestStatus: 'ingesting',
    });
  });
  return finishPreview(ctx, photo);
}

async function finishPreview(ctx: IngestCtx, photo: PhotoRow): Promise<PhotoRow> {
  const { db, hub, sessionsDir } = ctx;
  const src = path.join(sessionDir(sessionsDir, photo.sessionId), photo.fileName);
  const dest = previewPath(sessionsDir, photo);
  mkdirSync(path.dirname(dest), { recursive: true });
  try {
    const r = await makePreview(src, dest, ctx.watermark);
    const ready = writeSynced(db, schema.photos, { id: photo.id, width: r.width, height: r.height, ingestStatus: 'ready' });
    hub.send('photo.ready', toDto(ready), ['staff', 'kiosk']);
    return ready;
  } catch (e) {
    const failed = writeSynced(db, schema.photos, { id: photo.id, ingestStatus: 'failed' });
    hub.send('photo.failed', { id: photo.id, error: (e as Error).message });
    return failed;
  }
}

/**
 * Crash recovery at boot: previews that never finished, and files the camera wrote
 * just before a crash (on disk, no row yet) for sessions still in play.
 */
export async function recoverIngest(ctx: IngestCtx): Promise<number> {
  const { db, sessionsDir } = ctx;
  let n = 0;
  for (const p of db.select().from(schema.photos).where(eq(schema.photos.ingestStatus, 'ingesting')).all()) {
    await finishPreview(ctx, p);
    n++;
  }
  const live = db.select().from(schema.photoSessions).where(and(
    inArray(schema.photoSessions.status, ['armed', 'shot_complete']),
    sql`coalesce(${schema.photoSessions.completedAt}, ${Date.now()}) > ${Date.now() - 24 * 3600_000}`,
  )).all();
  for (const s of live) {
    const dir = sessionDir(sessionsDir, s.id);
    if (!existsSync(dir)) continue;
    const known = new Set(db.select({ f: schema.photos.fileName }).from(schema.photos)
      .where(eq(schema.photos.sessionId, s.id)).all().map((r) => r.f));
    for (const f of readdirSync(dir).filter((f) => JPEG_EXT.test(f) && !known.has(f)).sort()) {
      await ingestFile(ctx, path.join(dir, f), f, s.id);
      n++;
    }
  }
  return n;
}
