import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { PRINT_INCHES, type PrintSize } from '@pmp/shared';

const DPI = 300; // DNP DS620A and PIXMA photo modes both print at 300 dpi
const PT_PER_IN = 72;

/** "6x8" → [6, 8] (short, long). Throws on nonsense so a bad request never reaches a printer. */
export function parseInches(size: PrintSize, custom: string | null): [number, number] {
  if (size !== 'custom') return PRINT_INCHES[size];
  const m = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(custom ?? '');
  if (!m) throw new Error('custom_size_required');
  const short = Math.min(Number(m[1]), Number(m[2])), long = Math.max(Number(m[1]), Number(m[2]));
  if (short < 2 || short > 13 || long > 19) throw new Error('custom_size_out_of_range');
  return [short, long];
}

/**
 * Builds a one-page PDF at the exact paper size: the photo is EXIF-rotated,
 * centre-cropped to fill the page (no white borders) and resampled to 300 dpi.
 * Page orientation follows the photo, so the driver never rotates or scales.
 */
export async function renderSheet(src: string, inches: [number, number], tiles = 1) {
  const upright = await sharp(src, { failOn: 'none' }).rotate().toBuffer({ resolveWithObject: true });
  const landscape = upright.info.width >= upright.info.height;
  const [wIn, hIn] = landscape ? [inches[1], inches[0]] : inches;
  const W = Math.round(wIn * DPI), H = Math.round(hIn * DPI);
  let jpeg: Buffer;
  if (tiles === 4) {
    // Wallet sheet: 2 × 2 copies, each cell keeps the photo's orientation (5x7 → four 2.5×3.5 in wallets).
    const cw = Math.floor(W / 2), ch = Math.floor(H / 2);
    const cell = await sharp(upright.data).resize(cw, ch, { fit: 'cover', position: 'centre' }).toBuffer();
    jpeg = await sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } })
      .composite([0, 1, 2, 3].map((i) => ({ input: cell, left: (i % 2) * cw, top: Math.floor(i / 2) * ch })))
      .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
      .toBuffer();
  } else {
    jpeg = await sharp(upright.data)
      .resize(W, H, { fit: 'cover', position: 'centre' })
      .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
      .toBuffer();
  }

  return { jpeg, landscape, wIn, hIn };
}

export async function buildPrintPdf(src: string, dest: string, inches: [number, number], tiles = 1): Promise<{ landscape: boolean }> {
  const { jpeg, landscape, wIn, hIn } = await renderSheet(src, inches, tiles);
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([wIn * PT_PER_IN, hIn * PT_PER_IN]);
  const img = await pdf.embedJpg(jpeg);
  page.drawImage(img, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  await writeFile(dest, await pdf.save());
  return { landscape };
}
