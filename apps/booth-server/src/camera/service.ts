import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@pmp/db';
import type { EventHub } from '../events';
import { ingestFile, sessionDir, uniquePath, type IngestCtx } from '../photos/ingest';
import { EdsdkDriver } from './edsdk';
import { MockDriver } from './mock';
import type { CameraDriver, CameraStatus, DriverKind } from './types';
import { WiaDriver } from './wia';

export interface CameraServiceOpts {
  db: Db;
  hub: EventHub;
  cameraId: string;
  unassignedDir: string;
  incomingDir: string;
  ingest: IngestCtx;
  driver: CameraDriver | null;
}

const OFFLINE: CameraStatus = {
  driver: 'none', connected: false, model: null, batteryPercent: null, onAcPower: false, canRemoteShutter: false, error: null,
};

/** Picks the driver: EDSDK first (remote shutter, fast), WIA when the Canon module cannot load. */
export function selectDriver(pref: 'auto' | DriverKind, incomingDir: string, quality: 'jpeg' | 'raw+jpeg'): CameraDriver | null {
  const wiaScript = path.join(import.meta.dirname, 'wia-poll.ps1').replace('app.asar', 'app.asar.unpacked');
  switch (pref) {
    case 'mock': return new MockDriver();
    case 'edsdk': return EdsdkDriver.load(quality);
    case 'wia': return new WiaDriver(wiaScript, incomingDir);
    case 'auto':
      if (process.platform !== 'win32') return null;
      return EdsdkDriver.load(quality) ?? new WiaDriver(wiaScript, incomingDir);
  }
}

/** One camera: owns its driver, routes each downloaded file to the session armed at shutter time. */
export class CameraService {
  status: CameraStatus = { ...OFFLINE };
  private pending = new Map<string, string | null>(); // target path → session id decided at download start
  private queue: Promise<unknown> = Promise.resolve(); // ingest serially: keeps seq numbers in shutter order

  constructor(private o: CameraServiceOpts) {}

  get cameraId() { return this.o.cameraId; }

  async start(): Promise<void> {
    const d = this.o.driver;
    if (!d) return this.setStatus({ ...OFFLINE, error: 'no_driver' });
    this.setStatus({ driver: d.kind, canRemoteShutter: d.canRemoteShutter });
    try {
      await d.start({
        status: (patch) => this.setStatus(patch),
        targetFor: (name) => {
          const sessionId = this.armedSessionId();
          const target = uniquePath(sessionId ? sessionDir(this.o.ingest.sessionsDir, sessionId) : this.o.unassignedDir, name);
          this.pending.set(target, sessionId);
          return target;
        },
        downloaded: (file, name) => {
          const sessionId = this.pending.get(file) ?? null;
          this.pending.delete(file);
          if (!sessionId) {
            this.o.hub.send('photo.unassigned', { fileName: path.basename(file) });
            return;
          }
          this.queue = this.queue.then(() => ingestFile(this.o.ingest, file, name, sessionId))
            .catch((e) => this.o.hub.send('photo.failed', { fileName: name, error: (e as Error).message }));
        },
        error: (e) => this.setStatus({ error: e.message }),
      });
    } catch (e) {
      this.setStatus({ connected: false, error: (e as Error).message });
    }
  }

  armedSessionId(): string | null {
    return this.o.db.select({ s: schema.cameras.armedSessionId }).from(schema.cameras)
      .where(eq(schema.cameras.id, this.o.cameraId)).get()?.s ?? null;
  }

  async takePicture(): Promise<void> {
    const d = this.o.driver;
    if (!d || !this.status.connected) throw new Error('camera_not_connected');
    if (!d.canRemoteShutter) throw new Error('remote_shutter_unsupported');
    await d.takePicture();
  }

  /** Resolves once every file downloaded so far is ingested (used by tests and shutdown). */
  idle(): Promise<unknown> { return this.queue; }

  async stop(): Promise<void> {
    await this.o.driver?.stop();
    await this.queue;
  }

  private setStatus(patch: Partial<CameraStatus>) {
    this.status = { ...this.status, ...patch };
    this.o.hub.send('camera.status', { cameraId: this.o.cameraId, ...this.status });
  }
}
