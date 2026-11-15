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
import { MirrorService } from './storage/mirror';
import { seedPackages } from './routes/pos';
import { cloudClient } from './cloud/client';
import { CloudSync } from './cloud/sync';
import { ensureTls, type TlsMaterial } from './lan/tls';

export function openBoothDb(config: Config): Db {
  // Not the mirror: its absence is how we detect an unplugged drive.
  for (const d of [config.dataDir, config.sessionsDir, config.unassignedDir, config.incomingDir, config.spoolDir]) {
    mkdirSync(d, { recursive: true });
  }
  return openDb(path.join(config.dataDir, 'booth.sqlite'), config.migrationsDir);
}

/**
 * Local id until the booth is linked to the cloud; then the cloud's booths.id.
 * Switching is only allowed before the first booking (ids are written into every row).
 */
export function boothIdOf(db: Db, cloudId?: string): string {
  const stored = getSetting(db, 'booth_id');
  if (cloudId && stored !== cloudId) {
    if (stored && db.select({ id: schema.bookings.id }).from(schema.bookings).where(eq(schema.bookings.boothId, stored)).limit(1).get()) {
      throw new Error(`This booth already has bookings under id ${stored}; PMP_BOOTH_ID ${cloudId} needs a fresh database.`);
    }
    if (stored) db.update(schema.cameras).set({ boothId: cloudId }).where(eq(schema.cameras.boothId, stored)).run();
    setSetting(db, 'booth_id', cloudId);
    return cloudId;
  }
  if (stored) return stored;
  const id = uuidv7();
  setSetting(db, 'booth_id', id);
  return id;
}

export interface Booth {
  app: ReturnType<typeof createApp>;
  db: Db;
  hub: EventHub;
  cameras: Map<string, CameraService>;
  printQueue: PrintQueue;
  mirror: MirrorService;
  /** Resolves once the LAN certificate exists (never, when LAN is off). */
  lanReady: Promise<TlsMaterial>;
  sync: CloudSync | null;
  stop(): Promise<void>;
}

export async function startBooth(config: Config, opts: { spooler?: Spooler; lanIps?: string[]; manualSync?: boolean } = {}): Promise<Booth> {
  const db = openBoothDb(config);
  const boothId = boothIdOf(db, config.cloud?.boothId);
  const hub = new EventHub();

  // Phase 1 runs one camera; more rows = more cameras (each needs its own driver instance).
  if (!db.select().from(schema.cameras).where(eq(schema.cameras.boothId, boothId)).get()) {
    writeSynced(db, schema.cameras, { id: uuidv7(), boothId, name: 'Caméra 1', driver: 'auto' });
  }
  seedPackages(db);
  const ingest: IngestCtx = {
    db, hub, sessionsDir: config.sessionsDir,
    watermark: getSetting(db, 'preview.watermark') ?? 'Picture Me Please · APERÇU',
  };
  // JPEG-only by default: ~7 MB/shot instead of ~32 MB, and half the USB transfer time.
  const quality = getSetting(db, 'camera.quality') === 'raw+jpeg' ? 'raw+jpeg' : 'jpeg';
  const mirror = new MirrorService({
    db, hub, photosDir: config.photosDir, mirrorDir: config.mirrorDir,
    sessionsDir: config.sessionsDir, unassignedDir: config.unassignedDir,
  });
  const cameras = new Map<string, CameraService>();
  for (const cam of db.select().from(schema.cameras).where(eq(schema.cameras.active, true)).all()) {
    const pref = (config.cameraDriver ?? cam.driver) as 'auto' | DriverKind;
    cameras.set(cam.id, new CameraService({
      db, hub, cameraId: cam.id, unassignedDir: config.unassignedDir, incomingDir: config.incomingDir, ingest,
      driver: selectDriver(pref, config.incomingDir, quality),
      onFileWritten: (f) => mirror.enqueue(f),
    }));
  }

  const spooler = opts.spooler ?? windowsSpooler();
  const printQueue = new PrintQueue({ db, hub, sessionsDir: config.sessionsDir, spoolDir: config.spoolDir, spooler });

  await recoverIngest(ingest);
  mirror.start(); // also catches up on anything written while the drive was unplugged
  printQueue.recover();
  await Promise.all([...cameras.values()].map((c) => c.start()));

  // Wi-Fi may come up after the app: the LAN side retries until the PC has a private address.
  let tls: TlsMaterial | null = null;
  const tlsDir = path.join(config.dataDir, 'tls');
  const lanReady = new Promise<TlsMaterial>((resolve) => {
    if (!config.lan) return;
    const attempt = async () => {
      try {
        resolve((tls = await ensureTls(tlsDir, opts.lanIps)));
      } catch (e) {
        if ((e as Error).message !== 'no_lan_address') console.error('LAN TLS setup failed', e);
        setTimeout(attempt, 30_000).unref();
      }
    };
    void attempt();
  });
  const cloud = config.cloud ? cloudClient(config.cloud) : null;
  const sync = cloud ? new CloudSync({ db, client: cloud, sessionsDir: config.sessionsDir, onPulled: () => hub.send('sync.pulled', {}) }) : null;
  const app = createApp({ db, config, hub, boothId, cameras, printQueue, spooler, mirror, get tls() { return tls; }, cloud, syncNow: sync ? () => sync.pull() : undefined });
  if (!opts.manualSync) sync?.start();
  return {
    app, db, hub, cameras, printQueue, mirror, lanReady, sync,
    async stop() {
      sync?.stop();
      await Promise.all([...cameras.values()].map((c) => c.stop()));
      await mirror.stop();
      db.$client.close();
    },
  };
}
