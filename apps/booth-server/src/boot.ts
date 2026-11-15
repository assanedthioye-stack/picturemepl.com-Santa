import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { getSetting, openDb, schema, setSetting, writeSynced, type Db } from '@pmp/db';
import { createApp } from './app';
import { CameraService, selectDriver } from './camera/service';
import type { DriverKind } from './camera/types';
import type { Config } from './config';
import { EventHub } from './events';
import { uuidv7 } from './ids';
import { recoverIngest, type IngestCtx } from './photos/ingest';
import { PrintQueue, windowsSpooler, type Spooler } from './print/router';

export function openBoothDb(config: Config): Db {
  for (const d of [config.dataDir, config.sessionsDir, config.unassignedDir, config.incomingDir, config.spoolDir]) {
    mkdirSync(d, { recursive: true });
  }
  return openDb(path.join(config.dataDir, 'booth.sqlite'), config.migrationsDir);
}

/** Booth id stays local until cloud pairing (Phase 2) replaces it with the real booths.id. */
export function boothIdOf(db: Db): string {
  let id = getSetting(db, 'booth_id');
  if (!id) setSetting(db, 'booth_id', (id = uuidv7()));
  return id;
}

export interface Booth {
  app: ReturnType<typeof createApp>;
  db: Db;
  hub: EventHub;
  cameras: Map<string, CameraService>;
  printQueue: PrintQueue;
  stop(): Promise<void>;
}

export async function startBooth(config: Config, opts: { spooler?: Spooler } = {}): Promise<Booth> {
  const db = openBoothDb(config);
  const boothId = boothIdOf(db);
  const hub = new EventHub();

  // Phase 1 runs one camera; more rows = more cameras (each needs its own driver instance).
  if (!db.select().from(schema.cameras).where(eq(schema.cameras.boothId, boothId)).get()) {
    writeSynced(db, schema.cameras, { id: uuidv7(), boothId, name: 'Caméra 1', driver: 'auto' });
  }
  const ingest: IngestCtx = {
    db, hub, sessionsDir: config.sessionsDir,
    watermark: getSetting(db, 'preview.watermark') ?? 'Picture Me Please · APERÇU',
  };
  const quality = getSetting(db, 'camera.quality') === 'jpeg' ? 'jpeg' : 'raw+jpeg';
  const cameras = new Map<string, CameraService>();
  for (const cam of db.select().from(schema.cameras).where(eq(schema.cameras.active, true)).all()) {
    const pref = (config.cameraDriver ?? cam.driver) as 'auto' | DriverKind;
    cameras.set(cam.id, new CameraService({
      db, hub, cameraId: cam.id, unassignedDir: config.unassignedDir, incomingDir: config.incomingDir, ingest,
      driver: selectDriver(pref, config.incomingDir, quality),
    }));
  }

  const spooler = opts.spooler ?? windowsSpooler();
  const printQueue = new PrintQueue({ db, hub, sessionsDir: config.sessionsDir, spoolDir: config.spoolDir, spooler });

  await recoverIngest(ingest);
  printQueue.recover();
  await Promise.all([...cameras.values()].map((c) => c.start()));

  const app = createApp({ db, config, hub, boothId, cameras, printQueue, spooler });
  return {
    app, db, hub, cameras, printQueue,
    async stop() {
      await Promise.all([...cameras.values()].map((c) => c.stop()));
      db.$client.close();
    },
  };
}
