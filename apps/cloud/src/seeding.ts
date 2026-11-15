import { COUNTRIES, type Country } from '@pmp/shared';
import type { Q } from './db';
import { newId, randomToken, sha256Hex } from './util';

/** Mall + event + booth (with its one-time sync token) + bookable slots in local time. */
export async function seed(q: Q, o: { country: Country; venue: string; city: string; from: string; to: string; open: string; close: string; minutes: number; capacity: number; event: string }) {
  const venueId = newId(), eventId = newId(), boothId = newId(), token = randomToken(32);
  await q.query('insert into venues (id, country, name, city) values ($1,$2,$3,$4)', [venueId, o.country, o.venue, o.city]);
  await q.query(`insert into events (id, venue_id, name_fr, name_en, starts_on, ends_on, status) values ($1,$2,$3,$3,$4,$5,'live')`,
    [eventId, venueId, o.event, o.from, o.to]);
  await q.query('insert into booths (id, event_id, name, token_hash) values ($1,$2,$3,$4)', [boothId, eventId, 'Cabine 1', await sha256Hex(token)]);
  const offset = COUNTRIES[o.country].utcOffsetMin * 60_000;
  const [oh, om] = o.open.split(':').map(Number) as [number, number];
  const [ch, cm] = o.close.split(':').map(Number) as [number, number];
  let n = 0;
  for (let day = Date.parse(`${o.from}T00:00:00Z`); day <= Date.parse(`${o.to}T00:00:00Z`); day += 86_400_000) {
    for (let t = day + (oh * 60 + om) * 60_000; t < day + (ch * 60 + cm) * 60_000; t += o.minutes * 60_000) {
      await q.query('insert into time_slots (id, booth_id, starts_at, ends_at, capacity) values ($1,$2,$3,$4,$5)',
        [newId(), boothId, t - offset, t - offset + o.minutes * 60_000, o.capacity]);
      n++;
    }
  }
  return { venueId, eventId, boothId, token, slots: n };
}

