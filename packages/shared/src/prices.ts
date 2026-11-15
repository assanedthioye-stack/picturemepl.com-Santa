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

export type PackageCode = (typeof PRICE_LIST)[number]['code'];

/** Same id on every booth and in the cloud, so online orders and booth carts point at the same package. */
export const packageId = (code: string, country: string) => `pkg_${code}_${country}`;

/** Formulas sold online (single prints and wallets are added at the booth). */
export const ONLINE_CODES: readonly string[] = ['essentiel', 'famille', 'prestige', 'numerique'];
