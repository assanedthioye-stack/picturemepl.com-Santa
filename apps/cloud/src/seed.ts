/**
 * Creates a mall, an event, a booth (prints its sync token once) and bookable time slots.
 *   pnpm --filter @pmp/cloud seed -- --country SN --venue "Centre commercial" --city Dakar \
 *     --from 2026-12-01 --to 2026-12-31 --open 10:00 --close 20:00 --minutes 15 --capacity 1
 */
import { parseArgs } from 'node:util';
import { COUNTRIES, type Country } from '@pmp/shared';
import { migrate, pgDb } from './db';
import { seed } from './seeding';
import { migrationFiles } from './node';

const { values: a } = parseArgs({
  options: {
    country: { type: 'string' }, venue: { type: 'string' }, city: { type: 'string' },
    from: { type: 'string' }, to: { type: 'string' }, open: { type: 'string', default: '10:00' }, close: { type: 'string', default: '20:00' },
    minutes: { type: 'string', default: '15' }, capacity: { type: 'string', default: '1' }, event: { type: 'string', default: 'Photos avec le Père Noël' },
  },
});
const country = (a.country ?? '').toUpperCase() as Country;
if (!(country in COUNTRIES) || !a.venue || !a.city || !a.from || !a.to) {
  console.error('usage: seed --country SN|BJ|CI --venue <name> --city <city> --from YYYY-MM-DD --to YYYY-MM-DD [--open 10:00 --close 20:00 --minutes 15 --capacity 1]');
  process.exit(1);
}

const db = pgDb(process.env.DATABASE_URL ?? 'postgres://pmp:pmp@127.0.0.1/pmp_dev');
await migrate(db, migrationFiles());
const r = await db.tx((t) => seed(t, { country, venue: a.venue!, city: a.city!, from: a.from!, to: a.to!, open: a.open!, close: a.close!, minutes: Number(a.minutes), capacity: Number(a.capacity), event: a.event! }));
console.log(`booth ${r.boothId} — ${r.slots} slots`);
console.log(`Set on the booth PC:\n  setx PMP_BOOTH_ID "${r.boothId}"\n  setx PMP_CLOUD_TOKEN "${r.token}"   (shown once)`);
await db.end();
