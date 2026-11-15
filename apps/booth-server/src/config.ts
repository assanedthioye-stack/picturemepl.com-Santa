import os from 'node:os';
import path from 'node:path';

export interface Config {
  /** Internal disk: database + print spool. Never point this at a removable drive. */
  root: string;
  dataDir: string;
  /** Primary photo storage (Sessions, Unassigned, Incoming). Defaults to root. */
  photosDir: string;
  /** Optional second copy of every original, e.g. on an external USB drive. */
  mirrorDir: string | null;
  sessionsDir: string;
  unassignedDir: string;
  incomingDir: string;
  spoolDir: string;
  migrationsDir: string;
  rendererDir: string | null;
  host: string;
  port: number;
  /** Per-boot secret handed by Electron main to the kiosk window only. */
  kioskToken: string;
  /** Force a camera driver ('edsdk' | 'wia' | 'mock'); otherwise the camera row decides. */
  cameraDriver: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const root = env.PMP_ROOT ?? (process.platform === 'win32' ? 'C:\\PhotoBooth' : path.join(os.homedir(), 'PhotoBooth'));
  if (!env.PMP_KIOSK_TOKEN || env.PMP_KIOSK_TOKEN.length < 32) throw new Error('PMP_KIOSK_TOKEN missing or too short');
  const photosDir = env.PMP_PHOTOS_DIR ?? root;
  const mirrorDir = env.PMP_MIRROR_DIR || null;
  if (mirrorDir && isSameOrInside(mirrorDir, photosDir)) throw new Error('PMP_MIRROR_DIR must be outside PMP_PHOTOS_DIR');
  if (mirrorDir && isSameOrInside(photosDir, mirrorDir)) throw new Error('PMP_PHOTOS_DIR must be outside PMP_MIRROR_DIR');
  return {
    root,
    dataDir: path.join(root, 'Data'),
    photosDir,
    mirrorDir,
    sessionsDir: path.join(photosDir, 'Sessions'),
    unassignedDir: path.join(photosDir, 'Unassigned'),
    incomingDir: path.join(photosDir, 'Incoming'),
    spoolDir: path.join(root, 'PrintSpool'),
    migrationsDir: env.PMP_MIGRATIONS_DIR ?? path.resolve(import.meta.dirname, '../../../packages/db/drizzle'),
    rendererDir: env.PMP_RENDERER_DIR ?? null,
    // Phase 1 has no LAN devices yet: loopback only until TLS + device pairing land.
    host: '127.0.0.1',
    port: Number(env.PMP_PORT ?? 4100),
    kioskToken: env.PMP_KIOSK_TOKEN,
    cameraDriver: env.PMP_CAMERA_DRIVER ?? null,
  };
}

function isSameOrInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
