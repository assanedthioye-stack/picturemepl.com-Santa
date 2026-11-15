import postgres from 'postgres';
import { createCloudApp } from '../src/app';
import { migrate, pgDb, type Db } from '../src/db';
import { migrationFiles } from '../src/node';
import type { PaymentsConfig } from '../src/payments/service';
import type { CheckResult, InitInput, Provider, ProviderId } from '../src/payments/types';
import { seed } from '../src/seeding';
import { devStorage } from '../src/storage';

export const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://pmp:pmp@127.0.0.1/postgres';
export const BASE = 'http://cloud.test';
export const WEB = 'https://web.test';

/** A provider the test drives by hand: init records the call, check returns whatever `next` says. */
export function scriptedProvider(id: ProviderId) {
  const inits: InitInput[] = [];
  const state: { next: CheckResult; checks: number } = { next: { status: 'pending', raw: {} }, checks: 0 };
  const p: Provider = {
    id,
    async init(i) {
      inits.push(i);
      return id === 'mtn' ? { kind: 'push', providerRef: `ref-${i.paymentId}` } : { kind: 'redirect', url: `https://pay.test/${i.paymentId}`, providerRef: `ref-${i.paymentId}` };
    },
    async check() { state.checks++; return state.next; },
  };
  return { p, inits, state };
}

/** Fresh database per test file, migrated, with one SN booth and one BJ booth. */
export async function makeCloud() {
  const name = `pmp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = postgres(ADMIN_URL, { max: 1 });
  await admin.unsafe(`create database ${name}`);
  const db: Db = pgDb(ADMIN_URL.replace(/\/[^/]+$/, `/${name}`));
  await migrate(db, migrationFiles());
  const today = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10); // tomorrow: every slot is in the future
  const sn = await db.tx((t) => seed(t, { country: 'SN', venue: 'Centre Démo', city: 'Dakar', from: today, to: today, open: '10:00', close: '12:00', minutes: 15, capacity: 1, event: 'Démo' }));
  const bj = await db.tx((t) => seed(t, { country: 'BJ', venue: 'Centre Démo', city: 'Cotonou', from: today, to: today, open: '10:00', close: '11:00', minutes: 30, capacity: 2, event: 'Démo' }));
  const cinet = scriptedProvider('cinetpay');
  const mtn = scriptedProvider('mtn');
  const payments: PaymentsConfig = {
    providers: { cinetpay: cinet.p, mtn: mtn.p }, route: { SN: 'cinetpay', CI: 'cinetpay', BJ: 'mtn' },
    apiUrl: BASE, merchant: { mtn_momo: '2290159089346' },
  };
  const files = new Map<string, { body: Uint8Array; type: string }>();
  const storage = devStorage({ baseUrl: BASE, secret: 's', files });
  const app = createCloudApp({ db, storage, payments, webUrl: WEB, secret: 'gallery-secret' });

  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.fetch(new Request(BASE + path, {
      method, headers: { ...(body !== undefined && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : body instanceof Uint8Array ? (body as unknown as BodyInit) : JSON.stringify(body),
    }));
    const text = await res.text();
    let json: any = text;
    try { json = JSON.parse(text); } catch { /* raw */ }
    return { status: res.status, json };
  };
  return {
    db, app, call, sn, bj, cinet, mtn, files, today,
    booth: (token: string) => ({ Authorization: `Bearer ${token}` }),
    async close() { await db.end(); await admin.unsafe(`drop database ${name} with (force)`); await admin.end(); },
  };
}
