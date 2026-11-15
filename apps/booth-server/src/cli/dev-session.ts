/**
 * DEV ONLY: creates a walk-in booking (+ a paid 4x6 print order) so the Photographer
 * screen and print router can be exercised before the Host and Cashier screens exist.
 *   pnpm --filter @pmp/booth-server dev:session
 */
import { schema, writeSynced } from '@pmp/db';
import { hashSecret } from '../auth/auth';
import { boothIdOf, openBoothDb } from '../boot';
import { loadConfig } from '../config';
import { humanCode, uuidv7 } from '../ids';

const db = openBoothDb(loadConfig({ ...process.env, PMP_KIOSK_TOKEN: 'x'.repeat(32) }));
const boothId = boothIdOf(db);
const customer = writeSynced(db, schema.customers, { id: uuidv7(), phone: '+221770000000', fullName: 'Famille Test' });
const booking = writeSynced(db, schema.bookings, {
  id: uuidv7(), code: humanCode(6), publicToken: uuidv7(), pinHash: await hashSecret('000000'),
  eventId: 'dev-event', boothId, customerId: customer.id, source: 'walk_in', status: 'checked_in', partySize: 4,
});
const session = writeSynced(db, schema.photoSessions, {
  id: uuidv7(), bookingId: booking.id, boothId, code: humanCode(4), status: 'dispatched',
});
const order = writeSynced(db, schema.orders, {
  id: uuidv7(), bookingId: booking.id, boothId, channel: 'booth', status: 'paid',
  subtotalXof: 5000, totalXof: 5000, vatBp: 1800, vatXof: 763, paidAt: Date.now(),
});
const item = writeSynced(db, schema.orderItems, {
  id: uuidv7(), orderId: order.id, kind: 'print', qty: 2, unitPriceXof: 2500, lineTotalXof: 5000,
});
console.log({ bookingCode: booking.code, sessionId: session.id, sessionCode: session.code, paidPrintOrderItemId: item.id });
