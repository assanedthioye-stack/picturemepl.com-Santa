export type DriverKind = 'edsdk' | 'wia' | 'mock';

export interface CameraStatus {
  driver: DriverKind | 'none';
  connected: boolean;
  model: string | null;
  /** 0–100, or null when unknown / on AC power. */
  batteryPercent: number | null;
  onAcPower: boolean;
  canRemoteShutter: boolean;
  error: string | null;
}

export interface DriverHandlers {
  status(patch: Partial<CameraStatus>): void;
  /** Called right before a download: returns the absolute, non-existing file path to write to. */
  targetFor(originalName: string): string;
  /** The file is fully written at `path`. */
  downloaded(path: string, originalName: string): void;
  /** The download to `path` (from targetFor) failed; nothing usable was written. */
  aborted(path: string): void;
  error(err: Error): void;
}

/**
 * One physical camera link. Drivers only move bytes from the camera to disk;
 * deciding which session a file belongs to is CameraService's job.
 */
export interface CameraDriver {
  readonly kind: DriverKind;
  readonly canRemoteShutter: boolean;
  start(h: DriverHandlers): Promise<void>;
  stop(): Promise<void>;
  /** Fire the shutter remotely. Throws if unsupported or not connected. */
  takePicture(): Promise<void>;
}

export const RAW_EXT = /\.(cr2|cr3|crw)$/i;
export const JPEG_EXT = /\.jpe?g$/i;
