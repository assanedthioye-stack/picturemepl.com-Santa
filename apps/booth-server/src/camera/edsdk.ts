import { createRequire } from 'node:module';
import type { CameraDriver, DriverHandlers } from './types';

/**
 * The subset of @brick-a-brack/napi-canon-cameras 0.1.5 we use (the package ships no typings).
 * Checked against its C++ sources: event names in src/library/events.h, CameraFile.downloadToFile,
 * Camera.connect(keepAlive), SaveTo=Host sets the host capacity automatically.
 */
interface CanonFile { name: string; downloadToFile(path: string): string }
interface CanonProperty { value: unknown; available: boolean }
interface CanonCamera {
  description: string;
  portName: string;
  connect(keepAlive?: boolean): void;
  disconnect(): void;
  takePicture(): void;
  getProperty(id: number): CanonProperty;
  setProperties(props: Record<number, unknown>): void;
}
interface CanonApi {
  cameraBrowser: {
    getCamera(index?: number): CanonCamera | undefined;
    setEventHandler(fn: (name: string, event: { camera?: CanonCamera; file?: CanonFile; property?: { identifier: number } }) => void): void;
  };
  CameraProperty: { ID: Record<string, number> };
  Option: { SaveTo: Record<string, unknown> };
  ImageQuality: { ID: Record<string, unknown> };
  watchCameras(intervalMs?: number): () => void;
}

const AC_POWER = 0xffffffff; // EDSDK reports this battery level on the AC adapter

export class EdsdkDriver implements CameraDriver {
  readonly kind = 'edsdk' as const;
  readonly canRemoteShutter = true;
  private camera: CanonCamera | null = null;
  private stopWatch: (() => void) | null = null;
  private batteryTimer: NodeJS.Timeout | null = null;
  private h!: DriverHandlers;

  private constructor(private api: CanonApi, private quality: 'jpeg' | 'raw+jpeg') {}

  /** Returns null when the native module or EDSDK.dll cannot load (non-Windows, missing VC++ runtime…). */
  static load(quality: 'jpeg' | 'raw+jpeg'): EdsdkDriver | null {
    try {
      const api = createRequire(import.meta.url)('@brick-a-brack/napi-canon-cameras') as CanonApi;
      return new EdsdkDriver(api, quality);
    } catch {
      return null;
    }
  }

  async start(h: DriverHandlers): Promise<void> {
    this.h = h;
    const { cameraBrowser, CameraProperty } = this.api;
    cameraBrowser.setEventHandler((name, event) => {
      try {
        switch (name) {
          case 'CameraAdd':
            this.connect();
            break;
          case 'CameraRemove':
          case 'CameraDisconnect':
            this.camera = null;
            h.status({ connected: false, model: null, batteryPercent: null, onAcPower: false });
            break;
          case 'DownloadRequest':
            // Fires for remote AND physical shutter presses (SaveTo=Host), once per file (RAW, then JPEG).
            if (event.file) this.download(event.file);
            break;
          case 'PropertyChangeValue':
            if (event.property?.identifier === CameraProperty.ID.BatteryLevel) this.readBattery();
            break;
          case 'Error':
            h.error(new Error('EDSDK reported an error'));
            break;
        }
      } catch (e) {
        h.error(e as Error);
      }
    });
    this.stopWatch = this.api.watchCameras(100); // pumps EDSDK events; downloads happen inside these ticks
    this.connect();
    this.batteryTimer = setInterval(() => this.readBattery(), 30_000);
  }

  private connect(): void {
    if (this.camera) return;
    const cam = this.api.cameraBrowser.getCamera(); // shortcut: first camera only; index by portName for multi-camera
    if (!cam) {
      this.h.status({ connected: false });
      return;
    }
    try {
      cam.connect(true); // keepAlive: extends the camera's auto power-off timer
      const { CameraProperty, Option, ImageQuality } = this.api;
      cam.setProperties({
        [CameraProperty.ID.SaveTo!]: Option.SaveTo.Host, // files go to this PC only; the wrapper sets host capacity for us
        [CameraProperty.ID.ImageQuality!]: this.quality === 'raw+jpeg'
          ? ImageQuality.ID.RAWAndLargeJPEGFine
          : ImageQuality.ID.LargeJPEGFine,
      });
      this.camera = cam;
      this.h.status({ connected: true, model: cam.description, error: null });
      this.readBattery();
    } catch (e) {
      this.h.status({ connected: false, error: (e as Error).message });
    }
  }

  private download(file: CanonFile): void {
    const target = this.h.targetFor(file.name);
    // shortcut: synchronous USB transfer (~1 s for RAW+JPEG on a T7) blocks this process; move EDSDK to a worker if it hurts
    const written = file.downloadToFile(target);
    this.h.downloaded(written, file.name);
  }

  private readBattery(): void {
    if (!this.camera) return;
    try {
      const v = Number(this.camera.getProperty(this.api.CameraProperty.ID.BatteryLevel!).value);
      if (v === AC_POWER) this.h.status({ batteryPercent: null, onAcPower: true });
      else if (Number.isFinite(v)) this.h.status({ batteryPercent: Math.max(0, Math.min(100, v)), onAcPower: false });
    } catch {
      /* property briefly unavailable while the camera is busy */
    }
  }

  async takePicture(): Promise<void> {
    if (!this.camera) throw new Error('camera_not_connected');
    this.camera.takePicture();
  }

  async stop(): Promise<void> {
    if (this.batteryTimer) clearInterval(this.batteryTimer);
    this.stopWatch?.();
    try { this.camera?.disconnect(); } catch { /* already gone */ }
    this.camera = null;
  }
}
