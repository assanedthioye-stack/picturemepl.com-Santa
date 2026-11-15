import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { schema, type Db } from '@pmp/db';
import { uuidv7 } from './ids';

export interface AuditEntry {
  action: string;
  actorId?: string | null;
  actorRole?: string | null;
  entity?: string;
  entityId?: string;
  data?: unknown;
}

/**
 * Append-only, hash-chained audit log: deleting or editing a row breaks the chain.
 * better-sqlite3 is synchronous, so read-last + insert cannot interleave.
 */
export function audit(db: Db, boothId: string, e: AuditEntry): void {
  db.transaction((tx) => {
    const prev = tx.select({ hash: schema.auditLogs.hash }).from(schema.auditLogs)
      .orderBy(sql`rowid desc`).limit(1).get(); // insertion order, not time
    const row = {
      id: uuidv7(),
      at: Date.now(),
      boothId,
      deviceId: 'booth-pc',
      actorId: e.actorId ?? null,
      actorRole: e.actorRole ?? null,
      action: e.action,
      entity: e.entity ?? null,
      entityId: e.entityId ?? null,
      data: e.data ?? null,
      prevHash: prev?.hash ?? null,
    };
    const hash = createHash('sha256').update(JSON.stringify(row)).digest('hex');
    tx.insert(schema.auditLogs).values({ ...row, hash }).run();
  });
}

/** Returns the id of the first row whose hash does not match, or null if the chain is intact. */
export function verifyAuditChain(db: Db): string | null {
  const rows = db.select().from(schema.auditLogs).orderBy(sql`rowid`).all();
  let prev: string | null = null;
  for (const r of rows) {
    const { hash, serverSeq: _s, ...rest } = r;
    const expected: string = createHash('sha256').update(JSON.stringify({ ...rest, prevHash: prev })).digest('hex');
    if (r.prevHash !== prev || hash !== expected) return r.id;
    prev = hash;
  }
  return null;
}
