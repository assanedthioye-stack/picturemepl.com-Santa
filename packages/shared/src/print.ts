/** 'wallet4' = one 5x7 sheet holding 4 wallet prints (2.5×3.5 in ≈ 6×9 cm). */
export const PRINT_SIZES = ['4x6', '5x7', '8x10', 'wallet4', 'custom'] as const;
export type PrintSize = (typeof PRINT_SIZES)[number];
/** Which physical printer handles a size. Names are resolved to Windows printers at print time. */
export type PrinterKey = 'dnp' | 'pixma';

export const PRINT_ROUTES: Record<PrintSize, PrinterKey> = {
  '4x6': 'dnp',
  '5x7': 'dnp',
  '8x10': 'pixma',
  wallet4: 'dnp',
  custom: 'pixma',
};

/** Short side × long side in inches. Orientation follows the photo. */
export const PRINT_INCHES: Record<Exclude<PrintSize, 'custom'>, [number, number]> = {
  '4x6': [4, 6],
  '5x7': [5, 7],
  '8x10': [8, 10],
  wallet4: [5, 7],
};

/** Copies of the photo laid out on one sheet (2 × 2 grid). */
export const PRINT_TILES: Partial<Record<PrintSize, number>> = { wallet4: 4 };

/** How the price list names each size (cm). */
export const PRINT_LABEL: Record<PrintSize, string> = {
  '4x6': '10×15', '5x7': '13×18', '8x10': '20×25', wallet4: '4 × 6×9', custom: '—',
};
