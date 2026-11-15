export const PRINT_SIZES = ['4x6', '5x7', '8x10', 'custom'] as const;
export type PrintSize = (typeof PRINT_SIZES)[number];
/** Which physical printer handles a size. Names are resolved to Windows printers at print time. */
export type PrinterKey = 'dnp' | 'pixma';

export const PRINT_ROUTES: Record<PrintSize, PrinterKey> = {
  '4x6': 'dnp',
  '5x7': 'dnp',
  '8x10': 'pixma',
  custom: 'pixma',
};

/** Short side × long side in inches. Orientation follows the photo. */
export const PRINT_INCHES: Record<Exclude<PrintSize, 'custom'>, [number, number]> = {
  '4x6': [4, 6],
  '5x7': [5, 7],
  '8x10': [8, 10],
};
