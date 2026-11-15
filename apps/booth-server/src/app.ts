import path from 'node:path';
import express from 'express';
import type { Db } from '@pmp/db';
import { authenticate } from './auth/auth';
import type { CameraService } from './camera/service';
import type { Config } from './config';
import type { EventHub } from './events';
import { errorHandler, requireJson } from './http';
import type { PrintQueue, Spooler } from './print/router';
import { authRoutes } from './routes/auth';
import { deviceRoutes } from './routes/devices';
import { kioskRoutes, kioskState } from './routes/kiosk';
import { sessionRoutes } from './routes/sessions';
import { queueRoutes } from './routes/queue';
import { posRoutes } from './routes/pos';
import type { MirrorService } from './storage/mirror';
import { lanGuard, pairingRoutes } from './lan/devices';
import type { TlsMaterial } from './lan/tls';

export interface Deps {
  db: Db;
  config: Config;
  hub: EventHub;
  boothId: string;
  cameras: Map<string, CameraService>;
  printQueue: PrintQueue;
  spooler: Spooler;
  mirror: MirrorService;
  /** null when LAN access is off. */
  tls: TlsMaterial | null;
}

export function createApp(deps: Deps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(lanGuard(deps.db, deps.config.httpsPort));
  app.use(express.json({ limit: '100kb' }));
  app.use(requireJson);
  app.use(authenticate(deps.db, deps.config.kioskToken));

  app.use(authRoutes(deps));
  app.use(pairingRoutes(deps));
  app.use(sessionRoutes(deps));
  app.use(queueRoutes(deps));
  app.use(posRoutes(deps));
  app.use(kioskRoutes(deps));
  app.use(deviceRoutes(deps));

  app.get('/api/events', (req, res) => {
    const p = req.principal;
    if (!p) return res.status(401).end();
    deps.hub.attach(req, res, p.kind === 'kiosk' ? 'kiosk' : 'staff', () =>
      p.kind === 'kiosk'
        ? [['kiosk.state', kioskState(deps.db)]]
        : [
          ...[...deps.cameras.values()].map((c) => ['camera.status', { cameraId: c.cameraId, ...c.status }] as [string, unknown]),
          ['storage.status', deps.mirror.status()],
        ]);
  });

  // The React build (staff UI + /kiosk). Unknown non-API paths fall back to the SPA.
  const ui = deps.config.rendererDir;
  if (ui) {
    app.use(express.static(ui, { index: 'index.html' }));
    app.get(/^\/(?!api\/|media\/).*/, (_req, res) => res.sendFile(path.join(ui, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
