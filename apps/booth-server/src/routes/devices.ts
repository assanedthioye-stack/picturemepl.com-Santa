import { existsSync } from 'node:fs';
import { Router } from 'express';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema, writeSynced } from '@pmp/db';
import { PRINT_SIZES, can } from '@pmp/shared';
import type { Deps } from '../app';
import { audit } from '../audit';
import { requirePerm, staffOf } from '../auth/auth';
import { HttpError } from '../http';
import { uuidv7 } from '../ids';
import { previewPath } from '../photos/ingest';
import { parseInches } from '../print/layout';
import { copiesUsed, resolvePrinter } from '../print/router';
import { kioskSessionId } from './kiosk';

const NewPrint = z.object({
  orderItemId: z.string().min(1),
  photoId: z.string().min(1),
  size: z.enum(PRINT_SIZES),
  customInches: z.string().optional(),
  copies: z.number().int().min(1).max(20),
});

/** Camera control, print jobs and preview files. */
export function deviceRoutes(deps: Deps): Router {
  const { db, hub, boothId, cameras, printQueue, spooler, config, mirror } = deps;
  const r = Router();

  r.get('/api/cameras', requirePerm('camera.view'), (_req, res) => {
    res.json([...cameras.values()].map((c) => ({ id: c.cameraId, armedSessionId: c.armedSessionId(), ...c.status })));
  });

  r.get('/api/storage', requirePerm('camera.view', 'print.view'), (_req, res) => res.json(mirror.status()));

  r.post('/api/cameras/:id/shutter', requirePerm('session.shoot'), async (req, res) => {
    const cam = cameras.get(String(req.params.id));
    if (!cam) throw new HttpError(404, 'camera_not_found');
    if (!cam.armedSessionId()) throw new HttpError(409, 'no_armed_session'); // never shoot into the void
    try {
      await cam.takePicture();
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
    res.json({ ok: true });
  });

  // Previews only: originals are never served over HTTP.
  r.get('/media/previews/:photoId', requirePerm('kiosk.view', 'camera.view', 'print.view'), (req, res) => {
    const photo = db.select().from(schema.photos).where(eq(schema.photos.id, String(req.params.photoId))).get();
    const isKiosk = req.principal?.kind === 'kiosk';
    if (!photo || (isKiosk && (photo.sessionId !== kioskSessionId(db) || photo.hidden))) throw new HttpError(404, 'not_found');
    const file = previewPath(config.sessionsDir, photo);
    if (!existsSync(file)) throw new HttpError(404, 'not_ready');
    res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
    res.sendFile(file);
  });

  r.post('/api/print-jobs', requirePerm('print.create'), (req, res) => {
    const body = NewPrint.parse(req.body);
    const user = staffOf(req);
    if (body.size === 'custom') {
      try { parseInches('custom', body.customInches ?? null); } catch (e) { throw new HttpError(400, (e as Error).message); }
    }
    const job = db.transaction((tx) => {
      const item = tx.select({ item: schema.orderItems, order: schema.orders }).from(schema.orderItems)
        .innerJoin(schema.orders, eq(schema.orders.id, schema.orderItems.orderId))
        .where(eq(schema.orderItems.id, body.orderItemId)).get();
      if (!item) throw new HttpError(404, 'order_item_not_found');
      if (item.order.status !== 'paid') throw new HttpError(402, 'order_not_paid'); // money first, then paper
      if (!['print', 'bundle'].includes(item.item.kind)) throw new HttpError(409, 'not_a_print_item');
      const photo = tx.select().from(schema.photos).where(eq(schema.photos.id, body.photoId)).get();
      if (!photo || photo.bookingId !== item.order.bookingId) throw new HttpError(404, 'photo_not_in_order');
      if (item.item.photoId && item.item.photoId !== photo.id) throw new HttpError(409, 'photo_mismatch');
      if (copiesUsed(tx as never, item.item.id) + body.copies > item.item.qty) throw new HttpError(409, 'copies_exceed_paid_qty');
      return writeSynced(tx, schema.printJobs, {
        id: uuidv7(), boothId, orderItemId: item.item.id, photoId: photo.id, printSize: body.size,
        customInches: body.customInches ?? null, copies: body.copies, status: 'queued', requestedBy: user.id,
      });
    });
    audit(db, boothId, { action: 'print.create', actorId: user.id, actorRole: user.role, entity: 'print_job', entityId: job.id, data: body });
    hub.send('print.updated', job);
    printQueue.kick();
    res.status(201).json(job);
  });

  r.get('/api/print-jobs', requirePerm('print.view'), (_req, res) => {
    res.json(db.select().from(schema.printJobs).orderBy(desc(schema.printJobs.createdAt)).limit(50).all());
  });

  // Setup aid: which Windows printer each size will use right now.
  r.get('/api/printers', requirePerm('print.view'), async (req, res) => {
    const installed = await spooler.listPrinters().catch(() => [] as string[]);
    const routes = Object.fromEntries(PRINT_SIZES.map((s) => {
      try { return [s, resolvePrinter(db, s, installed)]; } catch (e) { return [s, { error: (e as Error).message }]; }
    }));
    res.json({ installed, routes, canPrint: can(staffOf(req).role, 'print.create') });
  });

  return r;
}
