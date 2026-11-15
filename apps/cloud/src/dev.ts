/**
 * Local cloud for development and demos: Postgres from DATABASE_URL, files in memory, fake payments allowed.
 *   DATABASE_URL=postgres://pmp:pmp@127.0.0.1/pmp_dev pnpm --filter @pmp/cloud dev
 */
import { serve } from '@hono/node-server';
import { createCloudApp } from './app';
import { migrate, pgDb } from './db';
import { paymentsFromEnv } from './env';
import { migrationFiles } from './node';
import { devStorage } from './storage';

const port = Number(process.env.PORT ?? 8787);
const base = `http://127.0.0.1:${port}`;
const db = pgDb(process.env.DATABASE_URL ?? 'postgres://pmp:pmp@127.0.0.1/pmp_dev');
await migrate(db, migrationFiles());
const env = { ALLOW_FAKE_PAYMENTS: '1', PROVIDER_SN: 'fake', PROVIDER_CI: 'fake', PROVIDER_BJ: 'fake', API_PUBLIC_URL: base, ...process.env };
const app = createCloudApp({
  db,
  storage: devStorage({ baseUrl: base, secret: 'dev-storage-secret', files: new Map() }),
  payments: paymentsFromEnv((k) => env[k as keyof typeof env] as string | undefined),
  webUrl: process.env.PUBLIC_WEB_URL ?? 'http://127.0.0.1:5174',
  secret: process.env.GALLERY_SECRET ?? 'dev-gallery-secret',
});
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => console.log(`cloud API on ${base}`));
