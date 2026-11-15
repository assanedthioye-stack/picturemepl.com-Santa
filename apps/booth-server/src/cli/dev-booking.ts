/**
 * DEV ONLY: creates a confirmed online appointment (what cloud sync will deliver in Phase 3)
 * so the Host check-in can be tried by code or QR.
 *   pnpm --filter @pmp/booth-server dev:booking [--code 482913] [--name "Famille Kouassi"]
 */
import { parseArgs } from 'node:util';
import { schema, writeSynced } from '@pmp/db';
import { hashSecret } from '../auth/auth';
import { boothIdOf, openBoothDb } from '../boot';
import { loadConfig } from '../config';
import { uuidv7 } from '../ids';
import { newBookingCode } from '../routes/queue';

const { values } = parseArgs({ options: { code: { type: 'string' }, name: { type: 'string' } } });
const db = openBoothDb(loadConfig({ ...process.env, PMP_KIOSK_TOKEN: 'x'.repeat(32) }));
const customer = writeSynced(db, schema.customers, { id: uuidv7(), phone: '+2250707123456', country: 'CI', fullName: values.name ?? 'Famille Kouassi' });
const booking = writeSynced(db, schema.bookings, {
  id: uuidv7(), code: values.code ?? newBookingCode(db), publicToken: uuidv7(), pinHash: await hashSecret('000000'),
  eventId: 'dev-event', boothId: boothIdOf(db), customerId: customer.id, source: 'online', status: 'confirmed', partySize: 3,
});
console.log({ bookingCode: booking.code, family: customer.fullName });
