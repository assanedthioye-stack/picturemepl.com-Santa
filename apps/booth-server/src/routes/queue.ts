import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getSetting, schema, writeSynced, type Db } from '@pmp/db';
import { COUNTRIES, extractBookingCode, normalizePhone, WALK_IN_CODE_PREFIX, type Country } from '@pmp/shared';
import type { Deps } from '../app';
import { audit } from '../audit';
import { hashSecret, requirePerm, staffOf, type StaffUser } from '../auth/auth';
import { HttpError } from '../http';
import { digitCode, humanCode, uuidv7 } from '../ids';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
const Q = schema.queueEntries;
/** Entries older than this are yesterday's leftovers and no longer shown. */
const QUEUE_WINDOW_MS = 18 * 3600_000;

/** 6-digit walk-in code: starts with 9 (online codes never do) and is unique on this booth (codes are per booth in the cloud too). */
export function newBookingCode(db: Db | Tx): string {
  for (;;) {
    const code = WALK_IN_CODE_PREFIX + digitCode(5);
    if (!db.select({ id: schema.bookings.id }).from(schema.bookings).where(eq(schema.bookings.code, code)).get()) return code;
  }
}

/** Creates the photo session the Photographer sees. Shared by the Host queue and the legacy dispatch API. */
export function dispatchSession(db: Db, boothId: string, bookingId: string, user: StaffUser) {
  const session = writeSynced(db, schema.photoSessions, {
    id: uuidv7(), bookingId, boothId, code: humanCode(4), dispatchedBy: user.id, status: 'dispatched',
  });
  audit(db, boothId, { action: 'session.dispatch', actorId: user.id, actorRole: user.role, entity: 'photo_session', entityId: session.id });
  return session;
}

export function setQueueStatus(tx: Db | Tx, bookingId: string, status: typeof Q.$inferSelect['status']) {
  const e = tx.select({ id: Q.id }).from(Q).where(eq(Q.bookingId, bookingId)).get();
  if (e) writeSynced(tx, Q, { id: e.id, status, ...(status === 'called' ? { calledAt: Date.now() } : {}) });
}

/**
 * Waiting families in serving order: supervisor overrides first, then checked-in appointments,
 * then walk-ins, each by time.
 */
export function queueList(db: Db) {
  // shortcut: booked entries sort by check-in time until time_slots sync from the cloud (Phase 3); then use slot start + grace window
  return db.select({
    id: Q.id, lane: Q.lane, status: Q.status, enqueuedAt: Q.enqueuedAt, calledAt: Q.calledAt,
    bookingId: schema.bookings.id, bookingCode: schema.bookings.code, partySize: schema.bookings.partySize,
    name: schema.customers.fullName, phone: schema.customers.phone,
  }).from(Q)
    .innerJoin(schema.bookings, eq(schema.bookings.id, Q.bookingId))
    .innerJoin(schema.customers, eq(schema.customers.id, schema.bookings.customerId))
    .where(and(inArray(Q.status, ['waiting', 'called', 'shooting']), gt(Q.enqueuedAt, Date.now() - QUEUE_WINDOW_MS)))
    .orderBy(sql`${Q.manualRank} is null`, Q.manualRank, sql`${Q.lane} = 'walk_in'`, Q.sortAt)
    .all();
}

const CheckIn = z.object({ code: z.string().min(6).max(500) });
const WalkIn = z.object({
  fullName: z.string().trim().min(2).max(80),
  phone: z.string().min(6).max(25),
  country: z.enum(Object.keys(COUNTRIES) as [Country, ...Country[]]),
  partySize: z.number().int().min(1).max(20).default(1),
});

export function queueRoutes({ db, hub, boothId, config, syncNow }: Deps): Router {
  const r = Router();
  const changed = () => hub.send('queue.updated', queueList(db));

  r.get('/api/queue', requirePerm('session.dispatch'), (_req, res) => res.json(queueList(db)));

  // QR scan or typed code → appointment joins the queue ahead of walk-ins.
  r.post('/api/queue/check-in', requirePerm('session.dispatch'), async (req, res) => {
    const code = extractBookingCode(CheckIn.parse(req.body).code);
    if (!code) throw new HttpError(400, 'invalid_code');
    const user = staffOf(req);
    const find = () => db.select().from(schema.bookings).where(and(eq(schema.bookings.code, code), eq(schema.bookings.boothId, boothId))).get()
      ?? db.select().from(schema.bookings).where(eq(schema.bookings.code, code)).get();
    let b = find();
    if (!b && syncNow) { await syncNow().catch(() => {}); b = find(); } // booked online moments ago
    if (!b) throw new HttpError(404, 'booking_not_found');
    if (b.boothId !== boothId) throw new HttpError(409, 'booking_other_booth');
    const now = Date.now();
    const existing = db.select().from(Q).where(eq(Q.bookingId, b.id)).get();
    if (existing) {
      if (existing.status === 'left' || existing.status === 'skipped') {
        // Stepped away and came back: they rejoin the queue instead of being told "already checked in".
        writeSynced(db, Q, { id: existing.id, status: 'waiting', sortAt: now, enqueuedAt: now });
        audit(db, boothId, { action: 'queue.rejoin', actorId: user.id, actorRole: user.role, entity: 'booking', entityId: b.id });
        changed();
        res.status(201).json({ entryId: existing.id, alreadyCheckedIn: false });
        return;
      }
      if (existing.status === 'done') throw new HttpError(409, `booking_${b.status}`);
      res.json({ entryId: existing.id, alreadyCheckedIn: true });
      return;
    }
    if (b.status === 'pending_payment') throw new HttpError(409, 'booking_unpaid');
    if (b.status !== 'confirmed') throw new HttpError(409, `booking_${b.status}`);
    const entry = db.transaction((tx) => {
      writeSynced(tx, schema.bookings, { id: b.id, status: 'checked_in', checkedInAt: now, checkedInBy: user.id });
      return writeSynced(tx, Q, { id: uuidv7(), boothId, bookingId: b.id, lane: 'booked', sortAt: now, status: 'waiting', enqueuedAt: now });
    });
    audit(db, boothId, { action: 'queue.check_in', actorId: user.id, actorRole: user.role, entity: 'booking', entityId: b.id });
    changed();
    res.status(201).json({ entryId: entry.id, alreadyCheckedIn: false });
  });

  r.post('/api/queue/walk-in', requirePerm('session.dispatch'), async (req, res) => {
    const body = WalkIn.parse(req.body);
    const phone = normalizePhone(body.country, body.phone);
    if (!phone) throw new HttpError(400, 'invalid_phone');
    const user = staffOf(req);
    // Gallery PIN: shown once to the family now; only its hash is kept (sent by SMS once the cloud lands).
    const pin = digitCode(6);
    const pinHash = await hashSecret(pin);
    const now = Date.now();
    const booking = db.transaction((tx) => {
      // A double tap (or a second tablet) must not put the same family in the queue twice.
      const dup = tx.select({ id: Q.id }).from(Q)
        .innerJoin(schema.bookings, eq(schema.bookings.id, Q.bookingId))
        .innerJoin(schema.customers, eq(schema.customers.id, schema.bookings.customerId))
        .where(and(eq(Q.boothId, boothId), eq(Q.status, 'waiting'), eq(schema.customers.phone, phone), gt(Q.enqueuedAt, now - QUEUE_WINDOW_MS))).get();
      if (dup) throw new HttpError(409, 'already_in_queue');
      const customer = writeSynced(tx, schema.customers, { id: uuidv7(), phone, country: body.country, fullName: body.fullName });
      const b = writeSynced(tx, schema.bookings, {
        id: uuidv7(), code: newBookingCode(tx), publicToken: randomBytes(16).toString('base64url'), pinHash, // gallery link: must be unguessable
        eventId: getSetting(db, 'event_id') ?? 'local', boothId, customerId: customer.id,
        source: 'walk_in', status: 'checked_in', partySize: body.partySize, checkedInAt: now, checkedInBy: user.id,
      });
      writeSynced(tx, Q, { id: uuidv7(), boothId, bookingId: b.id, lane: 'walk_in', sortAt: now, status: 'waiting', enqueuedAt: now });
      return b;
    });
    audit(db, boothId, { action: 'queue.walk_in', actorId: user.id, actorRole: user.role, entity: 'booking', entityId: booking.id });
    changed();
    res.status(201).json({ bookingCode: booking.code, pin, galleryUrl: config.webUrl ? `${config.webUrl}/b/${booking.publicToken}` : null });
  });

  // "Send to Photographer": the family's name + code pop up on the Photographer screen.
  r.post('/api/queue/:id/send', requirePerm('session.dispatch'), (req, res) => {
    const user = staffOf(req);
    // One transaction: a crash can never leave a session without its queue entry marked "called".
    const session = db.transaction((tx) => {
      const e = tx.select().from(Q).where(eq(Q.id, String(req.params.id))).get();
      if (!e) throw new HttpError(404, 'queue_entry_not_found');
      if (e.status !== 'waiting') throw new HttpError(409, `queue_${e.status}`);
      const s = dispatchSession(tx as unknown as Db, boothId, e.bookingId, user);
      setQueueStatus(tx, e.bookingId, 'called');
      return s;
    });
    hub.send('session.updated', session);
    changed();
    res.status(201).json(session);
  });

  r.post('/api/queue/:id/left', requirePerm('session.dispatch'), (req, res) => {
    const user = staffOf(req);
    const e = db.select().from(Q).where(and(eq(Q.id, String(req.params.id)), eq(Q.status, 'waiting'))).get();
    if (!e) throw new HttpError(404, 'queue_entry_not_found');
    writeSynced(db, Q, { id: e.id, status: 'left' });
    audit(db, boothId, { action: 'queue.left', actorId: user.id, actorRole: user.role, entity: 'booking', entityId: e.bookingId });
    changed();
    res.json({ ok: true });
  });

  return r;
}
