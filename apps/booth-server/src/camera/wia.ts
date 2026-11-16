import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { renameSync, copyFileSync, unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { CameraDriver, DriverHandlers } from './types';

/**
 * Windows Image Acquisition fallback: works with the in-box Windows camera driver, no Canon SDK.
 * The camera keeps saving to its SD card (a free backup); a PowerShell poller copies new files.
 * Limits: no remote shutter, ~1.5 s polling delay, no live settings.
 */
export class WiaDriver implements CameraDriver {
  readonly kind = 'wia' as const;
  readonly canRemoteShutter = false;
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopping = false;

  constructor(private scriptPath: string, private stagingDir: string) {}

  async start(h: DriverHandlers): Promise<void> {
    if (process.platform !== 'win32') throw new Error('WIA is only available on Windows');
    this.stopping = false;
    this.spawn(h);
  }

  private spawn(h: DriverHandlers): void {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', this.scriptPath, '-OutDir', this.stagingDir,
    ], { windowsHide: true });
    this.child = child;

    createInterface({ input: child.stdout }).on('line', (line) => {
      let msg: { type: string; [k: string]: unknown };
      try { msg = JSON.parse(line); } catch { return; } // ignore stray PowerShell output
      if (msg.type === 'status') {
        const battery = typeof msg.battery === 'number' ? msg.battery : null;
        h.status({ connected: msg.connected === true, model: (msg.model as string) ?? null, batteryPercent: battery, error: null });
      } else if (msg.type === 'file') {
        // An exception here would be uncaught (stream callback) and take the whole server down.
        const name = String(msg.name);
        let target: string | null = null;
        try {
          target = h.targetFor(name);
          moveFile(String(msg.path), target);
          h.downloaded(target, name);
        } catch (e) {
          if (target) h.aborted(target);
          h.error(e as Error);
        }
      } else if (msg.type === 'error') {
        h.status({ error: String(msg.message) });
      }
    });
    child.stderr.on('data', (d) => h.status({ error: String(d).trim().slice(0, 300) }));
    child.on('exit', () => {
      this.child = null;
      if (!this.stopping) setTimeout(() => this.spawn(h), 2000); // the poller should never die; restart it
    });
  }

  async takePicture(): Promise<void> {
    throw new Error('remote_shutter_unsupported');
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.child?.kill();
  }
}

/** Same-volume rename is atomic; fall back to copy for a staging dir on another drive. */
export function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    copyFileSync(from, to);
    unlinkSync(from);
  }
}
