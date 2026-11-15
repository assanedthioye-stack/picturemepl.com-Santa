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

/**
 * Official price list "Tarifs par pays", October 2026 (VAT-inclusive XOF, per family/child).
 * Not sold at the booth: "Photo de classe" and "Mosaïque de classe" (school products).
 * Wallets ("format portefeuille", 6×9 cm) print 4 to a 13×18 sheet: 4 wallets = 1 sheet, 8 = 2.
 */
export const PRICE_LIST_VERSION = '2026-10';
export const PRICE_LIST = [
  { code: 'essentiel', nameFr: 'Essentiel', nameEn: 'Essential', sort: 1, digitalsIncluded: 1,
    prints: { '5x7': 1, '4x6': 2, wallet4: 1 }, price: { SN: 7_500, CI: 9_000, BJ: 6_500 } },
  { code: 'famille', nameFr: 'Famille', nameEn: 'Family', sort: 2, digitalsIncluded: 1,
    prints: { '8x10': 1, '5x7': 2, '4x6': 2, wallet4: 2 }, price: { SN: 10_000, CI: 12_000, BJ: 8_500 } },
  // shortcut: the "retouche premium" in Prestige is done by hand outside the app; add a retouch flag to orders when it gets a workflow
  { code: 'prestige', nameFr: 'Prestige', nameEn: 'Prestige', sort: 3, digitalsIncluded: -1,
    prints: { '8x10': 2, '5x7': 2, '4x6': 4, wallet4: 2 }, price: { SN: 18_000, CI: 21_500, BJ: 15_500 } },
  { code: 'numerique', nameFr: 'Numérique', nameEn: 'Digital', sort: 4, digitalsIncluded: 1,
    prints: {}, price: { SN: 5_000, CI: 6_000, BJ: 4_500 } },
  { code: 'tirage_20x25', nameFr: 'Tirage 20 × 25 cm', nameEn: '20 × 25 cm print', sort: 10, digitalsIncluded: 0,
    prints: { '8x10': 1 }, price: { SN: 3_500, CI: 4_000, BJ: 3_000 } },
  { code: 'tirage_13x18', nameFr: 'Tirage 13 × 18 cm', nameEn: '13 × 18 cm print', sort: 11, digitalsIncluded: 0,
    prints: { '5x7': 1 }, price: { SN: 2_500, CI: 3_500, BJ: 2_500 } },
  { code: 'tirages_10x15', nameFr: '2 tirages 10 × 15 cm', nameEn: '2 × 10 × 15 cm prints', sort: 12, digitalsIncluded: 0,
    prints: { '4x6': 2 }, price: { SN: 1_500, CI: 2_000, BJ: 1_500 } },
  { code: 'portefeuille', nameFr: 'Format portefeuille (8 × 6×9 cm)', nameEn: 'Wallets (8 × 6×9 cm)', sort: 13, digitalsIncluded: 0,
    prints: { wallet4: 2 }, price: { SN: 1_500, CI: 2_000, BJ: 1_500 } },
] as const;
