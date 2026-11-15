import postgres from 'postgres';

export interface Q {
  query<T = Record<string, any>>(text: string, params?: unknown[]): Promise<T[]>;
}
export interface Db extends Q {
  tx<T>(fn: (q: Q) => Promise<T>): Promise<T>;
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
  return {
    ...q(sql),
    tx: (fn) => sql.begin((t) => fn(q(t as unknown as typeof sql))) as never,
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
