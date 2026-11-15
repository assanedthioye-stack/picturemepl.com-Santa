import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { mkdirUnder } from '../src/storage/mirror';
import { KIOSK_TOKEN, makeBooth } from './harness';

let t: Awaited<ReturnType<typeof makeBooth>>;
let mirror = '';
let photos = '';
beforeAll(async () => {
  t = await makeBooth((root) => {
    photos = path.join(root, 'ExternalPhotos');
    mirror = path.join(root, 'Backup');
    mkdirSync(mirror); // operator creates the backup folder once on the USB drive
    return { PMP_PHOTOS_DIR: photos, PMP_MIRROR_DIR: mirror };
  });
});
afterAll(async () => { await t.close(); });

async function shoot(n: number) {
  const ph = t.client();
  await ph.login((await t.addUser('photographer')).id);
  const host = t.client();
  await host.login((await t.addUser('host')).id);
  const booking = t.seedBooking();
  const session = await (await host.post('/api/sessions', { bookingCode: booking.code })).json();
  await ph.post(`/api/sessions/${session.id}/arm`);
  const cam = [...t.booth.cameras.values()][0]!;
  for (let i = 0; i < n; i++) expect((await ph.post(`/api/cameras/${cam.cameraId}/shutter`)).status).toBe(200);
  await cam.idle();
  await t.booth.mirror.idle();
  await ph.post(`/api/sessions/${session.id}/complete`);
  return { sessionId: session.id as string, ph };
}

describe('storage', () => {
  it('keeps the database on the internal root and photos on the photos drive', () => {
    expect(existsSync(path.join(t.root, 'Data', 'booth.sqlite'))).toBe(true);
    expect(existsSync(path.join(photos, 'Sessions'))).toBe(true);
    expect(existsSync(path.join(photos, 'Data'))).toBe(false);
  });

  it('mirrors every original byte-for-byte, previews excluded', async () => {
    const { sessionId, ph } = await shoot(2);
    const src = path.join(photos, 'Sessions', sessionId, 'IMG_0001.JPG');
    const copy = path.join(mirror, 'Sessions', sessionId, 'IMG_0001.JPG');
    expect(readFileSync(copy).equals(readFileSync(src))).toBe(true);
    expect(existsSync(path.join(mirror, 'Sessions', sessionId, 'previews'))).toBe(false);
    const status = await (await ph.get('/api/storage')).json();
    expect(status.mirror).toMatchObject({ enabled: true, connected: true, pending: 0, lastError: null });
    expect(status.photosFreeGb).toBeGreaterThan(0);
  });

  it('warns instead of failing when the drive is unplugged, then catches up', async () => {
    renameSync(mirror, `${mirror}-unplugged`);
    const { sessionId, ph } = await shoot(1);
    // The shoot itself still worked.
    expect(existsSync(path.join(photos, 'Sessions', sessionId, 'previews'))).toBe(true);
    const status = await (await ph.get('/api/storage')).json();
    expect(status.mirror).toMatchObject({ connected: false, pending: 1, lastError: 'mirror_drive_missing' });

    renameSync(`${mirror}-unplugged`, mirror);
    // No sweep: the next successful copy alone must pull the missed one along.
    await shoot(1);
    await t.booth.mirror.idle();
    const [shot] = readdirSync(path.join(photos, 'Sessions', sessionId)).filter((f) => f.endsWith('.JPG'));
    expect(existsSync(path.join(mirror, 'Sessions', sessionId, shot!))).toBe(true);
    expect((await (await ph.get('/api/storage')).json()).mirror).toMatchObject({ connected: true, pending: 0, lastError: null });
  });

  it('never recreates a vanished backup root', async () => {
    const gone = path.join(t.root, 'gone-drive');
    await expect(mkdirUnder(gone, path.join(gone, 'Sessions', 'x'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(existsSync(gone)).toBe(false);
  });

  it('refuses a mirror inside the photos folder (it would copy into itself)', () => {
    const base = { PMP_KIOSK_TOKEN: KIOSK_TOKEN, PMP_PHOTOS_DIR: '/x/photos' };
    expect(() => loadConfig({ ...base, PMP_MIRROR_DIR: '/x/photos/backup' })).toThrow('outside');
    expect(() => loadConfig({ ...base, PMP_MIRROR_DIR: '/x/photos' })).toThrow('outside');
    expect(loadConfig({ ...base, PMP_MIRROR_DIR: '/y/backup' }).mirrorDir).toBe('/y/backup');
  });
});
