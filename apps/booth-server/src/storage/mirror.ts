import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, statfsSync, statSync } from 'node:fs';
import { copyFile, mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { gt } from 'drizzle-orm';
import { schema, type Db } from '@pmp/db';
import type { EventHub } from '../events';

const LOW_SPACE_GB = 20;
const SWEEP_MS = 60_000;
const RECENT_MS = 48 * 3600_000;

export interface StorageStatus {
  photosFreeGb: number | null;
  photosLow: boolean;
  mirror: {
    enabled: boolean;
    /** The mirror folder exists right now (drive plugged in). */
    connected: boolean;
    /** Files waiting for (or that failed) their second copy. */
    pending: number;
    freeGb: number | null;
    low: boolean;
    lastError: string | null;
  };
}

function freeGb(dir: string): number | null {
  try {
    const s = statfsSync(dir);
    return Math.round((s.bavail * s.bsize) / 1e9 * 10) / 10;
  } catch {
    return null;
  }
}

/**
 * mkdir below `root` only, one level at a time. Unlike mkdir -p, it can never recreate a
 * vanished root, so an unplugged drive always surfaces as ENOENT instead of a fresh empty folder.
 */
export async function mkdirUnder(root: string, dir: string): Promise<void> {
  let cur = root;
  for (const part of path.relative(root, dir).split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    try { await mkdir(cur); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  }
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * Keeps a verified second copy of every original under mirrorDir (same relative layout).
 * The mirror folder must already exist: if it is missing we treat the drive as unplugged,
 * warn, and catch up on the next sweep instead of failing the shoot.
 */
export class MirrorService {
  private chain: Promise<unknown> = Promise.resolve();
  private queued = new Set<string>();
  private failed = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private lastError: string | null = null;

  constructor(private o: { db: Db; hub: EventHub; photosDir: string; mirrorDir: string | null; sessionsDir: string; unassignedDir: string }) {}

  start(): void {
    this.sweep();
    this.timer = setInterval(() => this.sweep(), SWEEP_MS);
    this.timer.unref();
  }

  stop(): Promise<unknown> {
    if (this.timer) clearInterval(this.timer);
    return this.chain;
  }

  /** Queue one freshly written original. Never throws: the shoot must go on. */
  enqueue(file: string): void {
    if (!this.o.mirrorDir || this.queued.has(file)) return;
    this.queued.add(file);
    this.chain = this.chain.then(() => this.copy(file)).finally(() => {
      this.queued.delete(file);
      this.publish();
    });
    this.publish();
  }

  /** Resolves when everything queued so far is copied (or given up for this round). */
  idle(): Promise<unknown> { return this.chain; }

  /** Re-queue recent originals whose copy is missing or has the wrong size (drive was unplugged, crash…). */
  sweep(): void {
    if (!this.o.mirrorDir) return this.publish();
    if (!existsSync(this.o.mirrorDir)) return this.publish();
    for (const file of this.recentOriginals()) {
      const dest = this.destOf(file);
      try {
        if (existsSync(dest) && statSync(dest).size === statSync(file).size) continue;
      } catch { /* file vanished (duplicate removed) */ continue; }
      this.enqueue(file);
    }
    this.publish();
  }

  status(): StorageStatus {
    const photosFreeGb = freeGb(this.o.photosDir);
    const m = this.o.mirrorDir;
    const connected = !!m && existsSync(m);
    const mirrorFree = connected ? freeGb(m!) : null;
    return {
      photosFreeGb,
      photosLow: photosFreeGb !== null && photosFreeGb < LOW_SPACE_GB,
      mirror: {
        enabled: !!m,
        connected,
        pending: new Set([...this.queued, ...this.failed]).size,
        freeGb: mirrorFree,
        low: mirrorFree !== null && mirrorFree < LOW_SPACE_GB,
        lastError: this.lastError,
      },
    };
  }

  private destOf(file: string): string {
    return path.join(this.o.mirrorDir!, path.relative(this.o.photosDir, file));
  }

  private async copy(file: string): Promise<void> {
    const mirror = this.o.mirrorDir!;
    if (!existsSync(mirror)) {
      this.failed.add(file);
      this.lastError = 'mirror_drive_missing';
      return;
    }
    if (!existsSync(file)) { this.failed.delete(file); return; } // e.g. duplicate deleted by ingest
    const dest = this.destOf(file);
    const part = `${dest}.part`;
    try {
      await mkdirUnder(mirror, path.dirname(dest));
      await copyFile(file, part);
      // Read both back: a flaky USB cable must not leave a silently corrupt backup.
      const [a, b] = await Promise.all([sha256(file), sha256(part)]);
      if (a !== b) throw new Error('mirror_verify_failed');
      await rename(part, dest);
      this.failed.delete(file);
      this.lastError = null;
      // The drive is back: retry earlier failures now rather than at the next sweep.
      for (const f of [...this.failed]) this.enqueue(f);
    } catch (e) {
      await unlink(part).catch(() => {});
      this.failed.add(file);
      const code = (e as NodeJS.ErrnoException).code;
      this.lastError = code === 'ENOENT' && !existsSync(mirror) ? 'mirror_drive_missing' : (e as Error).message;
    }
  }

  private recentOriginals(): string[] {
    const dirs = this.o.db.select({ id: schema.photoSessions.id }).from(schema.photoSessions)
      .where(gt(schema.photoSessions.createdAt, Date.now() - RECENT_MS)).all()
      .map((s) => path.join(this.o.sessionsDir, s.id));
    dirs.push(this.o.unassignedDir);
    const files: string[] = [];
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      // Originals only: previews/ are regenerated from them.
      for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isFile()) files.push(path.join(dir, e.name));
    }
    return files;
  }

  private publish(): void {
    this.o.hub.send('storage.status', this.status());
  }
}
