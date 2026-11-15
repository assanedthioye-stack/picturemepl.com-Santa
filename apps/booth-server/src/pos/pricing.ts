import type { PrintSize } from '@pmp/shared';

export interface Pkg { id: string; priceXof: number; digitalsIncluded: number; prints: Partial<Record<PrintSize, number>> }
export interface Cart {
  lines: Array<{ packageId: string; qty: number }>;
  /** Photos delivered as digital files. */
  digitalPhotoIds: string[];
  /** One entry per print included in the packages. */
  printSlots: Array<{ size: PrintSize; photoId: string }>;
}
export interface Priced {
  subtotalXof: number;
  vatXof: number;
  totalXof: number;
  /** -1 = unlimited. */
  digitalsAllowed: number;
  printsAllowed: Partial<Record<PrintSize, number>>;
}

/**
 * Server-side price + entitlement check. Prices are VAT-inclusive whole XOF,
 * so VAT is extracted: vat = round(total × rate / (1 + rate)).
 * Throws a short error code when the cart does not match what the packages include.
 */
export function priceCart(packages: Map<string, Pkg>, cart: Cart, vatBp: number, photoIds: Set<string>): Priced {
  if (cart.lines.length === 0) throw new Error('empty_cart');
  let subtotal = 0;
  let digitals = 0;
  const prints: Partial<Record<PrintSize, number>> = {};
  for (const { packageId, qty } of cart.lines) {
    const p = packages.get(packageId);
    if (!p) throw new Error('unknown_package');
    if (!Number.isInteger(qty) || qty < 1) throw new Error('bad_qty');
    subtotal += p.priceXof * qty;
    digitals = digitals === -1 || p.digitalsIncluded === -1 ? -1 : digitals + p.digitalsIncluded * qty;
    for (const [size, n] of Object.entries(p.prints) as [PrintSize, number][]) prints[size] = (prints[size] ?? 0) + n * qty;
  }

  const ids = [...cart.digitalPhotoIds, ...cart.printSlots.map((s) => s.photoId)];
  if (ids.some((id) => !photoIds.has(id))) throw new Error('photo_not_in_booking');
  if (new Set(cart.digitalPhotoIds).size !== cart.digitalPhotoIds.length) throw new Error('duplicate_digital');
  if (digitals === 0 && cart.digitalPhotoIds.length > 0) throw new Error('digitals_not_included');
  if (digitals > 0 && cart.digitalPhotoIds.length > digitals) throw new Error('too_many_digitals');
  if (digitals !== 0 && cart.digitalPhotoIds.length === 0) throw new Error('choose_digital_photos');

  const slots: Partial<Record<PrintSize, number>> = {};
  for (const s of cart.printSlots) slots[s.size] = (slots[s.size] ?? 0) + 1;
  for (const size of new Set([...Object.keys(prints), ...Object.keys(slots)]) as Set<PrintSize>) {
    if ((slots[size] ?? 0) !== (prints[size] ?? 0)) throw new Error(`print_slots_mismatch_${size}`);
  }

  const vat = Math.round((subtotal * vatBp) / (10_000 + vatBp));
  return { subtotalXof: subtotal, vatXof: vat, totalXof: subtotal, digitalsAllowed: digitals, printsAllowed: prints };
}

/** Placeholder price list seeded on first start. Set real prices before launch (Admin screen: Phase 3). */
export const DEFAULT_PACKAGES = [
  { code: 'digital', nameFr: 'Pack numérique', nameEn: 'Digital pack', priceXof: 10_000, digitalsIncluded: -1, prints: {}, sort: 1 },
  { code: 'dnp_4x6', nameFr: 'Pack 3 tirages 10×15', nameEn: '3 × 4x6 prints', priceXof: 7_500, digitalsIncluded: 0, prints: { '4x6': 3 }, sort: 2 },
  { code: 'pixma_8x10', nameFr: 'Pack 2 tirages 20×25', nameEn: '2 × 8x10 prints', priceXof: 15_000, digitalsIncluded: 0, prints: { '8x10': 2 }, sort: 3 },
  { code: 'combo', nameFr: 'Combo : numérique + 3 × 10×15 + 1 × 20×25', nameEn: 'Combo: digital + 3 × 4x6 + 1 × 8x10', priceXof: 25_000, digitalsIncluded: -1, prints: { '4x6': 3, '8x10': 1 }, sort: 4 },
] as const;
