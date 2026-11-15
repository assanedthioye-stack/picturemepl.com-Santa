import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const MIGRATIONS = path.resolve(import.meta.dirname, '../../../supabase/migrations');

export function migrationFiles(dir = MIGRATIONS) {
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).map((name) => ({ name, sql: readFileSync(path.join(dir, name), 'utf8') }));
}
