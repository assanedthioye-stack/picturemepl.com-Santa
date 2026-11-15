import sharp from 'sharp';

const PREVIEW_EDGE = 1600;

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Diagonal repeated text, sized to the image so it survives cropping a phone photo of the screen. */
export function watermarkSvg(width: number, height: number, text: string): Buffer {
  const fontSize = Math.round(Math.max(width, height) / 28);
  const stepX = fontSize * (text.length * 0.62 + 3); // ~0.62 em per glyph + a gap, so tiles never overlap
  const stepY = fontSize * 4;
  const t = escapeXml(text);
  let rows = '';
  for (let row = 0, y = -height; y < height * 2; row++, y += stepY) {
    for (let x = -width + (row % 2) * (stepX / 2); x < width * 2; x += stepX) {
      rows += `<text x="${x}" y="${y}">${t}</text>`;
    }
  }
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <g transform="rotate(-30 ${width / 2} ${height / 2})" font-family="Segoe UI, Arial, sans-serif"
         font-size="${fontSize}" font-weight="700" fill="#ffffff" fill-opacity="0.28"
         stroke="#000000" stroke-opacity="0.18" stroke-width="${Math.max(1, fontSize / 30)}">${rows}</g>
    </svg>`,
  );
}

export interface PreviewResult { width: number; height: number; previewWidth: number; previewHeight: number }

/**
 * Low-res watermarked preview for screens. The full-res original is never modified.
 * sharp shrinks JPEGs while decoding, so a 24 MP T7 frame takes ~200–300 ms.
 */
export async function makePreview(src: string, dest: string, watermark: string): Promise<PreviewResult> {
  const meta = await sharp(src).metadata();
  const resized = await sharp(src, { failOn: 'none' })
    .rotate() // apply EXIF orientation (portrait shots)
    .resize({ width: PREVIEW_EDGE, height: PREVIEW_EDGE, fit: 'inside', withoutEnlargement: true })
    .toBuffer({ resolveWithObject: true });
  const { width, height } = resized.info;
  await sharp(resized.data)
    .composite([{ input: watermarkSvg(width, height, watermark) }])
    .jpeg({ quality: 78, mozjpeg: true })
    .toFile(dest);
  // Report the upright size of the original (orientation 5–8 swaps axes).
  const swap = (meta.orientation ?? 1) >= 5;
  return {
    width: (swap ? meta.height : meta.width) ?? width,
    height: (swap ? meta.width : meta.height) ?? height,
    previewWidth: width,
    previewHeight: height,
  };
}
