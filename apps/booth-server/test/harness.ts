import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { schema, writeSynced } from '@pmp/db';
import { hashSecret } from '../src/auth/auth';
import { boothIdOf, startBooth, type Booth } from '../src/boot';
import { loadConfig } from '../src/config';
import { humanCode, uuidv7 } from '../src/ids';
import type { PrintOptions, Spooler } from '../src/print/router';

export const KIOSK_TOKEN = 'k'.repeat(48);

export interface Printed { pdf: Buffer; o: PrintOptions }

export async function makeBooth() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pmp-'));
  const printed: Printed[] = [];
  const spooler: Spooler = {
    listPrinters: async () => ['Microsoft Print to PDF', 'DNP DS620A', 'Canon PIXMA TS8320'],
    print: async (pdf, o) => { printed.push({ pdf: readFileSync(pdf), o }); },
  };
  const config = loadConfig({ PMP_ROOT: root, PMP_KIOSK_TOKEN: KIOSK_TOKEN, PMP_CAMERA_DRIVER: 'mock' });
  const booth: Booth = await startBooth(config, { spooler });
  const server = booth.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const boothId = boothIdOf(booth.db);

  async function addUser(role: typeof schema.users.$inferInsert['role'], secret = '1234') {
    return writeSynced(booth.db, schema.users, { id: uuidv7(), fullName: `${role} user`, role, pinHash: await hashSecret(secret) });
  }

  function seedBooking() {
    const c = writeSynced(booth.db, schema.customers, { id: uuidv7(), phone: '+221770000001' });
    return writeSynced(booth.db, schema.bookings, {
      id: uuidv7(), code: humanCode(6), publicToken: uuidv7(), pinHash: 'x', eventId: 'e', boothId,
      customerId: c.id, source: 'walk_in', status: 'checked_in',
    });
  }

  function seedOrder(bookingId: string, status: 'open' | 'paid', qty = 2) {
    const o = writeSynced(booth.db, schema.orders, { id: uuidv7(), bookingId, channel: 'booth', status, vatBp: 1800 });
    return writeSynced(booth.db, schema.orderItems, { id: uuidv7(), orderId: o.id, kind: 'print', qty, unitPriceXof: 2500, lineTotalXof: 2500 * qty });
  }

  /** A browser-like client with its own cookie jar. */
  function client() {
    let cookie = '';
    const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(base + url, {
        method, redirect: 'manual',
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0]!;
      return res;
    };
    return {
      get: (url: string) => call('GET', url),
      post: (url: string, body: unknown = {}, headers?: Record<string, string>) => call('POST', url, body, headers),
      async login(userId: string, secret = '1234') { return call('POST', '/api/auth/login', { userId, secret }); },
    };
  }

  return {
    booth, base, root, printed, boothId, addUser, seedBooking, seedOrder, client,
    async close() { server.close(); await booth.stop(); rmSync(root, { recursive: true, force: true }); },
  };
}
