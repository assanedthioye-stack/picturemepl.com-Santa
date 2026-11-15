import sharp from 'sharp';
import type { CameraDriver, DriverHandlers } from './types';

/** Development/test camera: renders a numbered JPEG on every "shutter press". */
export class MockDriver implements CameraDriver {
  readonly kind = 'mock' as const;
  readonly canRemoteShutter = true;
  private h: DriverHandlers | null = null;
  private n = 0;

  async start(h: DriverHandlers): Promise<void> {
    this.h = h;
    h.status({ connected: true, model: 'Mock EOS', batteryPercent: 87, onAcPower: false, error: null });
  }

  async takePicture(): Promise<void> {
    if (!this.h) throw new Error('camera_not_connected');
    const name = `IMG_${String(++this.n).padStart(4, '0')}.JPG`;
    const target = this.h.targetFor(name);
    const hue = (this.n * 47) % 360;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="2000">
      <rect width="100%" height="100%" fill="hsl(${hue},55%,45%)"/>
      <text x="50%" y="55%" font-size="400" text-anchor="middle" fill="white" font-family="sans-serif">#${this.n}</text></svg>`;
    await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toFile(target);
    this.h.downloaded(target, name);
  }

  async stop(): Promise<void> {
    this.h = null;
  }
}
