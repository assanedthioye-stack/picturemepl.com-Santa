import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { renderSheet } from './layout';

describe('wallet sheet', () => {
  it('puts 4 copies of the photo on one 5x7 sheet, following its orientation', async () => {
    // Landscape photo: left half red, right half blue.
    const src = path.join(mkdtempSync(path.join(os.tmpdir(), 'pmp-')), 'p.jpg');
    await sharp({ create: { width: 600, height: 400, channels: 3, background: '#0000ff' } })
      .composite([{ input: { create: { width: 300, height: 400, channels: 3, background: '#ff0000' } }, left: 0, top: 0 }])
      .jpeg().toFile(src);
    const sheet = await renderSheet(src, [5, 7], 4);
    expect([sheet.wIn, sheet.hIn, sheet.landscape]).toEqual([7, 5, true]);
    const { data, info } = await sharp(sheet.jpeg).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([2100, 1500]);
    const red = (x: number, y: number) => data[(y * info.width + x) * 3]! > 200 && data[(y * info.width + x) * 3 + 2]! < 60;
    // Left cell: red then blue; right cell starts red again → two copies side by side.
    expect([red(100, 375), red(950, 375), red(1150, 375), red(2000, 375)]).toEqual([true, false, true, false]);
    expect([red(100, 1125), red(1150, 1125)]).toEqual([true, true]); // second row
  });
});
