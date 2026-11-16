import postgres from 'postgres';

export interface Q {
  query<T = Record<string, any>>(text: string, params?: unknown[]): Promise<T[]>;
}
/** Inside a transaction. `savepoint` isolates a step: if it throws, only that step is rolled back. */
export interface Tx extends Q {
  savepoint<T>(fn: (q: Tx) => Promise<T>): Promise<T>;
}
export interface Db extends Q {
  tx<T>(fn: (q: Tx) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

/** Postgres via postgres.js (works on Node and in Supabase Edge Functions). */
export function pgDb(url: string): Db {
  const sql = postgres(url, {
    prepare: false, // Supabase's transaction pooler cannot keep prepared statements
    max: 5,
    onnotice: () => {},
    // Epoch-ms bigints and counts fit in a JS number.
    types: { bigint: { to: 20, from: [20], parse: (v: string) => Number(v), serialize: (v: number) => String(v) } },
  });
  const q = (s: { unsafe: typeof sql.unsafe }): Q => ({
    query: async (text, params = []) => [...(await s.unsafe(text, params as never[]))] as never,
  });
  // postgres.js fails the whole transaction for any query error, even a caught one, unless it happened in its own savepoint scope.
  const inTx = (t: any): Tx => ({ ...q(t), savepoint: (fn) => t.savepoint((sp: unknown) => fn(inTx(sp))) });
  return {
    ...q(sql),
    tx: (fn) => sql.begin((t) => fn(inTx(t))) as never,
    end: () => sql.end(),
  };
}

/** Applies supabase/migrations/*.sql in order (Node dev/tests; production uses `supabase db push`). */
export async function migrate(db: Db, files: Array<{ name: string; sql: string }>): Promise<void> {
  await db.query('create table if not exists _migrations (name text primary key, at timestamptz not null default now())');
  const done = new Set((await db.query<{ name: string }>('select name from _migrations')).map((r) => r.name));
  for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) {
    if (done.has(f.name)) continue;
    await db.tx(async (t) => {
      await t.query(f.sql);
      await t.query('insert into _migrations (name) values ($1)', [f.name]);
    });
  }
}
