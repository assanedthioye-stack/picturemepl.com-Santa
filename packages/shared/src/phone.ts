/** Booth countries. Benin moved to 10-digit numbers ("01…") in Nov 2024; Côte d'Ivoire in 2021. */
export const COUNTRIES = {
  SN: { prefix: '221', digits: 9, nameFr: 'Sénégal', nameEn: 'Senegal', momo: ['orange_money', 'wave'] },
  BJ: { prefix: '229', digits: 10, nameFr: 'Bénin', nameEn: 'Benin', momo: ['mtn_momo', 'celtiis_cash'] },
  CI: { prefix: '225', digits: 10, nameFr: "Côte d'Ivoire", nameEn: "Côte d'Ivoire", momo: ['orange_money', 'wave'] },
} as const;
export type Country = keyof typeof COUNTRIES;
/** Mobile Money accepted per country (price list, Oct 2026). */
export const MOMO_METHODS = ['wave', 'orange_money', 'mtn_momo', 'celtiis_cash'] as const;
export type MomoMethod = (typeof MOMO_METHODS)[number];

/** Accepts "77 123 45 67", "+221771234567", "00221…"; returns E.164 or null. Leading zeros are kept (they are part of BJ/CI numbers). */
export function normalizePhone(country: Country, input: string): string | null {
  let d = input.replace(/[\s.\-()]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  const { prefix, digits } = COUNTRIES[country];
  if (d.startsWith(prefix) && d.length === prefix.length + digits) d = d.slice(prefix.length);
  return /^\d+$/.test(d) && d.length === digits ? `+${prefix}${d}` : null;
}

/** Pulls the 6-digit booking code out of whatever a QR or keyboard-wedge scanner produced. */
export function extractBookingCode(text: string): string | null {
  return /(?<!\d)(\d{6})(?!\d)/.exec(text)?.[1] ?? null;
}
