/** Supabase Edge Function entry ("api"). Deploy with --no-verify-jwt: the routes do their own auth. */
import { createCloudApp } from './app';
import { pgDb } from './db';
import { paymentsFromEnv } from './env';
import { supabaseStorage } from './storage';

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (r: Request) => Response | Promise<Response>): void };
const get = (k: string) => Deno.env.get(k);
const need = (k: string) => get(k) ?? (() => { throw new Error(`missing env ${k}`); })();

const app = createCloudApp({
  db: pgDb(need('SUPABASE_DB_URL')),
  storage: supabaseStorage({ url: need('SUPABASE_URL'), serviceKey: need('SUPABASE_SERVICE_ROLE_KEY'), bucket: get('PHOTO_BUCKET') ?? 'photos' }),
  payments: paymentsFromEnv(get),
  webUrl: need('PUBLIC_WEB_URL').replace(/\/$/, ''),
  secret: need('GALLERY_SECRET'),
});
Deno.serve(app.fetch);
