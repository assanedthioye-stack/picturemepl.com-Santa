import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getSetting, schema, setSetting, writeSynced, type Db } from '@pmp/db';
import type { Deps } from '../app';
import { requirePerm } from '../auth/auth';
import { HttpError } from '../http';
import { toDto, type PhotoDto } from '../photos/ingest';

const KEY = 'kiosk.session_id';
const Favorite = z.object({ favorite: z.boolean() });

export interface KioskState { session: { id: string; code: string } | null; photos: PhotoDto[] }

export function setKioskSession(db: Db, sessionId: string | null) {
  if (sessionId) setSetting(db, KEY, sessionId);
  else db.delete(schema.settings).where(eq(schema.settings.key, KEY)).run();
}

export function kioskSessionId(db: Db): string | null {
  return getSetting(db, KEY) ?? null;
}

/** What the family screen shows: only ready, non-hidden previews of the current session. */
export function kioskState(db: Db): KioskState {
  const id = kioskSessionId(db);
  const s = id ? db.select().from(schema.photoSessions).where(eq(schema.photoSessions.id, id)).get() : undefined;
  if (!s) return { session: null, photos: [] };
  const photos = db.select().from(schema.photos)
    .where(and(eq(schema.photos.sessionId, s.id), eq(schema.photos.ingestStatus, 'ready'), eq(schema.photos.hidden, false)))
    .orderBy(schema.photos.seq).all().map(toDto);
  return { session: { id: s.id, code: s.code }, photos };
}

export function kioskRoutes({ db, hub }: Deps): Router {
  const r = Router();

  r.get('/api/kiosk/state', requirePerm('kiosk.view', 'camera.view'), (_req, res) => res.json(kioskState(db)));

  r.post('/api/kiosk/photos/:id/favorite', requirePerm('kiosk.favorite'), (req, res) => {
    const { favorite } = Favorite.parse(req.body);
    const photo = db.select().from(schema.photos).where(eq(schema.photos.id, String(req.params.id))).get();
    // The kiosk may only touch the family currently on screen.
    if (!photo || photo.sessionId !== kioskSessionId(db) || photo.hidden || photo.ingestStatus !== 'ready') {
      throw new HttpError(404, 'photo_not_found');
    }
    const row = writeSynced(db, schema.photos, { id: photo.id, favorite });
    hub.send('photo.updated', toDto(row), ['staff', 'kiosk']);
    res.json(toDto(row));
  });

  r.post('/api/kiosk/clear', requirePerm('session.shoot'), (_req, res) => {
    setKioskSession(db, null);
    hub.send('kiosk.state', kioskState(db), ['staff', 'kiosk']);
    res.json({ ok: true });
  });

  return r;
}
