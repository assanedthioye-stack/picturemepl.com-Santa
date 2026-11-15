import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq, getTableName, type InferSelectModel } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import * as schema from './schema';

export * as schema from './schema';
export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export function openDb(file: string, migrationsFolder: string): Db {
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = FULL'); // mall power cuts: never lose a paid sale
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema }) as Db;
  migrate(db, { migrationsFolder });
  return db;
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type SyncedTable = SQLiteTable & { id: any; updatedAt: any };

/**
 * Upsert a synced row and queue it for cloud push, atomically.
 * Every write to a synced table must go through here so Phase 2 sync sees it.
 */
export function writeSynced<T extends SyncedTable>(
  tx: Db | Tx,
  table: T,
  row: Partial<InferSelectModel<T>> & { id: string },
): InferSelectModel<T> {
  const values = { ...row, updatedAt: Date.now() } as any;
  const t = tx as Db;
  // Not an upsert: SQLite checks NOT NULL on the insert row before ON CONFLICT, so partial patches would fail.
  const exists = t.select({ id: table.id }).from(table as SQLiteTable).where(eq(table.id, row.id)).get();
  const saved = (exists
    ? t.update(table).set(values).where(eq(table.id, row.id)).returning().get()
    : t.insert(table).values(values).returning().get()) as InferSelectModel<T>;
  tx.insert(schema.syncOutbox)
    .values({ tbl: getTableName(table), rowId: row.id, payload: JSON.stringify(saved), createdAt: Date.now() })
    .run();
  return saved;
}

export function getSetting(db: Db, key: string): string | undefined {
  return db.select().from(schema.settings).where(eq(schema.settings.key, key)).get()?.value;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.insert(schema.settings).values({ key, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } }).run();
}
