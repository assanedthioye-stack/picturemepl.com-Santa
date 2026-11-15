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
  const a = Number(m[1]), b = Number(m[2]);
  if (a < 2 || b < 2 || a > 13 || b > 19) throw new Error('custom_size_out_of_range');
  return [Math.min(a, b), Math.max(a, b)];
}

/**
 * Builds a one-page PDF at the exact paper size: the photo is EXIF-rotated,
 * centre-cropped to fill the page (no white borders) and resampled to 300 dpi.
 * Page orientation follows the photo, so the driver never rotates or scales.
 */
export async function buildPrintPdf(src: string, dest: string, inches: [number, number]): Promise<{ landscape: boolean }> {
  const upright = await sharp(src, { failOn: 'none' }).rotate().toBuffer({ resolveWithObject: true });
  const landscape = upright.info.width >= upright.info.height;
  const [wIn, hIn] = landscape ? [inches[1], inches[0]] : inches;
  const jpeg = await sharp(upright.data)
    .resize(Math.round(wIn * DPI), Math.round(hIn * DPI), { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .toBuffer();

  const pdf = await PDFDocument.create();
  const page = pdf.addPage([wIn * PT_PER_IN, hIn * PT_PER_IN]);
  const img = await pdf.embedJpg(jpeg);
  page.drawImage(img, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  await writeFile(dest, await pdf.save());
  return { landscape };
}
