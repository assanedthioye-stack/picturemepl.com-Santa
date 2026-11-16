import { Router } from 'express';
import { and, desc, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema, writeSynced } from '@pmp/db';
import type { Deps } from '../app';
import { audit } from '../audit';
import { requirePerm, staffOf } from '../auth/auth';
import { HttpError } from '../http';
import { toDto } from '../photos/ingest';
import { enqueueGalleryUploads } from '../cloud/uploads';
import { kioskSessionId, kioskState, setKioskSession } from './kiosk';
import { dispatchSession, setQueueStatus } from './queue';

const Dispatch = z.object({ bookingCode: z.string().trim().toUpperCase().min(4).max(12) });
const Arm = z.object({ cameraId: z.string().optional() });
const Hidden = z.object({ hidden: z.boolean() });

export function sessionRoutes(deps: Deps): Router {
  const { db, hub, boothId, cameras } = deps;
  const r = Router();
  const S = schema.photoSessions;

  const emit = (id: string) => hub.send('session.updated', db.select().from(S).where(eq(S.id, id)).get());

  // Host → Photographer. (Full Host screen arrives in Phase 2; this is the API it will call.)
  r.post('/api/sessions', requirePerm('session.dispatch'), (req, res) => {
    const { bookingCode } = Dispatch.parse(req.body);
    const user = staffOf(req);
    const booking = db.select().from(schema.bookings).where(eq(schema.bookings.code, bookingCode)).get();
    if (!booking) throw new HttpError(404, 'booking_not_found');
    if (!['confirmed', 'checked_in', 'shot_complete'].includes(booking.status)) throw new HttpError(409, `booking_${booking.status}`);
    const session = dispatchSession(db, boothId, booking.id, user);
    emit(session.id);
    res.status(201).json(session);
  });

  r.get('/api/sessions', requirePerm('session.shoot', 'session.dispatch'), (_req, res) => {
    const photoCount = sql<number>`(select count(*) from photos p where p.session_id = ${S.id} and p.ingest_status = 'ready' and p.hidden = 0)`;
    res.json(db.select({ session: S, bookingCode: schema.bookings.code, partySize: schema.bookings.partySize, familyName: schema.customers.fullName, photoCount })
      .from(S).innerJoin(schema.bookings, eq(schema.bookings.id, S.bookingId))
      .innerJoin(schema.customers, eq(schema.customers.id, schema.bookings.customerId))
      // Paid families leave the shoot list: no reshoot button once the order is settled.
      .where(and(inArray(S.status, ['dispatched', 'armed', 'shot_complete']), ne(schema.bookings.status, 'completed'), gt(S.createdAt, Date.now() - 18 * 3600_000)))
      .orderBy(desc(S.createdAt)).all()
      .map((r) => ({ ...r.session, bookingCode: r.bookingCode, partySize: r.partySize, familyName: r.familyName, photoCount: r.photoCount })));
  });

  r.post('/api/sessions/:id/arm', requirePerm('session.shoot'), (req, res) => {
    const user = staffOf(req);
    const cameraId = Arm.parse(req.body ?? {}).cameraId ?? [...cameras.keys()][0];
    if (!cameraId || !cameras.has(cameraId)) throw new HttpError(404, 'camera_not_found');
    db.transaction((tx) => {
      const s = tx.select().from(S).where(eq(S.id, String(req.params.id))).get();
      if (!s) throw new HttpError(404, 'session_not_found');
      if (s.status !== 'dispatched' && s.status !== 'shot_complete') throw new HttpError(409, `session_${s.status}`);
      const booking = tx.select({ status: schema.bookings.status }).from(schema.bookings).where(eq(schema.bookings.id, s.bookingId)).get();
      if (booking?.status === 'completed') throw new HttpError(409, 'booking_completed');
      const cam = tx.select().from(schema.cameras).where(eq(schema.cameras.id, cameraId)).get()!;
      if (cam.armedSessionId && cam.armedSessionId !== s.id) throw new HttpError(409, 'camera_busy');
      writeSynced(tx, schema.cameras, { id: cameraId, armedSessionId: s.id, armedBy: user.id, armedAt: Date.now() });
      writeSynced(tx, S, { id: s.id, status: 'armed', cameraId, photographerId: user.id, armedAt: s.armedAt ?? Date.now(), completedAt: null });
      writeSynced(tx, schema.bookings, { id: s.bookingId, status: 'in_session' });
      setQueueStatus(tx, s.bookingId, 'shooting');
    });
    setKioskSession(db, String(req.params.id));
    audit(db, boothId, { action: 'session.arm', actorId: user.id, actorRole: user.role, entity: 'photo_session', entityId: String(req.params.id), data: { cameraId } });
    emit(String(req.params.id));
    hub.send('kiosk.state', kioskState(db), ['staff', 'kiosk']);
    res.json({ ok: true });
  });

  r.post('/api/sessions/:id/complete', requirePerm('session.shoot'), async (req, res) => {
    const user = staffOf(req);
    const id = String(req.params.id);
    const first = db.select().from(S).where(eq(S.id, id)).get();
    if (!first) throw new HttpError(404, 'session_not_found');
    if (first.status !== 'armed') throw new HttpError(409, `session_${first.status}`);
    // Let the last shots finish downloading and previewing: every photo must reach the cashier and the gallery.
    if (first.cameraId) await cameras.get(first.cameraId)?.idle();
    const s = db.transaction((tx) => {
      const s = tx.select().from(S).where(eq(S.id, id)).get()!;
      if (s.status !== 'armed') throw new HttpError(409, `session_${s.status}`); // a second tap while we waited
      if (s.cameraId) writeSynced(tx, schema.cameras, { id: s.cameraId, armedSessionId: null, armedBy: null, armedAt: null });
      writeSynced(tx, S, { id: s.id, status: 'shot_complete', completedAt: Date.now() });
      writeSynced(tx, schema.bookings, { id: s.bookingId, status: 'shot_complete' });
      setQueueStatus(tx, s.bookingId, 'done');
      // Online gallery: small previews now; every original later (so photos bought online after the event exist).
      for (const p of tx.select({ id: schema.photos.id }).from(schema.photos)
        .where(and(eq(schema.photos.sessionId, s.id), eq(schema.photos.ingestStatus, 'ready'), eq(schema.photos.hidden, false))).all()) {
        enqueueGalleryUploads(tx as never, p.id);
      }
      return s;
    });
    // The kiosk keeps showing this family's photos so they can keep picking favourites.
    audit(db, boothId, { action: 'session.complete', actorId: user.id, actorRole: user.role, entity: 'photo_session', entityId: s.id });
    emit(s.id);
    res.json({ ok: true });
  });

  r.get('/api/sessions/:id/photos', requirePerm('session.shoot', 'print.view'), (req, res) => {
    // Only ready photos: an 'ingesting' row has no preview file yet (photo.ready announces it later).
    res.json(db.select().from(schema.photos)
      .where(and(eq(schema.photos.sessionId, String(req.params.id)), eq(schema.photos.ingestStatus, 'ready')))
      .orderBy(schema.photos.seq).all().map(toDto));
  });

  r.post('/api/photos/:id/hidden', requirePerm('session.shoot'), (req, res) => {
    const { hidden } = Hidden.parse(req.body);
    const photo = db.select().from(schema.photos).where(eq(schema.photos.id, String(req.params.id))).get();
    if (!photo) throw new HttpError(404, 'photo_not_found');
    if (hidden) {
      // A photo the family paid for would vanish from their online gallery.
      const sold = db.select({ id: schema.orderItems.id }).from(schema.orderItems)
        .innerJoin(schema.orders, eq(schema.orders.id, schema.orderItems.orderId))
        .where(and(eq(schema.orderItems.photoId, photo.id), eq(schema.orders.status, 'paid'))).get();
      if (sold) throw new HttpError(409, 'photo_sold');
    }
    const row = writeSynced(db, schema.photos, { id: photo.id, hidden, favorite: hidden ? false : photo.favorite });
    if (!hidden) {
      // Shown again after the shoot was closed: it still has to reach the gallery.
      const session = db.select({ status: S.status }).from(S).where(eq(S.id, photo.sessionId)).get();
      if (session?.status === 'shot_complete') enqueueGalleryUploads(db, photo.id);
    }
    hub.send('photo.updated', toDto(row));
    // The family screen only hears about its own session, and gets the full list (a photo may reappear).
    if (row.sessionId === kioskSessionId(db)) hub.send('kiosk.state', kioskState(db), ['kiosk']);
    res.json(toDto(row));
  });

  return r;
}
