import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema, type Db } from '@pmp/db';

export type UploadKind = 'thumb' | 'preview' | 'deliverable';
/** Marker for a job closed because its photo was hidden; un-hiding the photo revives it. */
export const SKIPPED_HIDDEN = 'skipped_hidden';

/** Queues one gallery file. An existing job only ever gains priority; skipped or failed jobs are revived. */
export function enqueueUpload(db: Db, photoId: string, kind: UploadKind, priority: number): void {
  const U = schema.uploadJobs;
  const existing = db.select().from(U).where(and(eq(U.photoId, photoId), eq(U.kind, kind))).get();
  if (!existing) {
    db.insert(U).values({ id: randomUUID(), photoId, kind, priority, status: 'queued', createdAt: Date.now() }).run();
    return;
  }
  const revive = existing.status === 'failed' || existing.lastError === SKIPPED_HIDDEN;
  if (revive) {
    db.update(U).set({ status: 'queued', attempts: 0, lastError: null, priority: Math.max(existing.priority, priority) }).where(eq(U.id, existing.id)).run();
  } else if (existing.status !== 'done' && existing.priority < priority) {
    db.update(U).set({ priority }).where(eq(U.id, existing.id)).run();
  }
}

/** Everything the online gallery needs for one photo: small previews soon, the original when the line is free. */
export function enqueueGalleryUploads(db: Db, photoId: string): void {
  enqueueUpload(db, photoId, 'thumb', 5);
  enqueueUpload(db, photoId, 'preview', 5);
  enqueueUpload(db, photoId, 'deliverable', 0);
}
