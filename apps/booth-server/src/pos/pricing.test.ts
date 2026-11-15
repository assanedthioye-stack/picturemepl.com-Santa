import { describe, expect, it } from 'vitest';
import { priceCart, type Pkg } from './pricing';

const pk = (id: string, priceXof: number, digitalsIncluded: number, prints: Pkg['prints']): [string, Pkg] => [id, { id, priceXof, digitalsIncluded, prints }];
const packages = new Map([pk('dig', 10_000, -1, {}), pk('p46', 7_500, 0, { '4x6': 3 }), pk('p810', 15_000, 0, { '8x10': 2 }), pk('two', 3_000, 2, {})]);
const photos = new Set(['a', 'b', 'c']);
const slots = (size: '4x6' | '8x10', ...ids: string[]) => ids.map((photoId) => ({ size, photoId }));

describe('priceCart', () => {
  it('prices VAT-inclusive XOF and extracts 18% VAT', () => {
    const r = priceCart(packages, { lines: [{ packageId: 'p46', qty: 2 }], digitalPhotoIds: [], printSlots: slots('4x6', 'a', 'a', 'b', 'b', 'c', 'c') }, 1800, photos);
    expect(r).toMatchObject({ subtotalXof: 15_000, totalXof: 15_000, vatXof: 2288 }); // 15000 × 18/118 = 2288.1
  });
  it('requires exactly the included prints, per size', () => {
    const cart = { lines: [{ packageId: 'p46', qty: 1 }, { packageId: 'p810', qty: 1 }], digitalPhotoIds: [] as string[] };
    expect(() => priceCart(packages, { ...cart, printSlots: slots('4x6', 'a', 'b', 'c') }, 1800, photos)).toThrow('print_slots_mismatch_8x10');
    expect(() => priceCart(packages, { ...cart, printSlots: [...slots('4x6', 'a', 'b', 'c'), ...slots('8x10', 'a', 'b', 'c')] }, 1800, photos)).toThrow('print_slots_mismatch_8x10');
    expect(priceCart(packages, { ...cart, printSlots: [...slots('4x6', 'a', 'b', 'c'), ...slots('8x10', 'a', 'c')] }, 1800, photos).totalXof).toBe(22_500);
  });
  it('enforces digital entitlements', () => {
    const base = { printSlots: [] };
    expect(priceCart(packages, { ...base, lines: [{ packageId: 'dig', qty: 1 }], digitalPhotoIds: ['a', 'b', 'c'] }, 1800, photos).digitalsAllowed).toBe(-1);
    expect(() => priceCart(packages, { ...base, lines: [{ packageId: 'two', qty: 1 }], digitalPhotoIds: ['a', 'b', 'c'] }, 1800, photos)).toThrow('too_many_digitals');
    expect(() => priceCart(packages, { ...base, lines: [{ packageId: 'p46', qty: 1 }], digitalPhotoIds: ['a'], printSlots: slots('4x6', 'a', 'b', 'c') }, 1800, photos)).toThrow('digitals_not_included');
    expect(() => priceCart(packages, { ...base, lines: [{ packageId: 'dig', qty: 1 }], digitalPhotoIds: [] }, 1800, photos)).toThrow('choose_digital_photos');
  });
  it('rejects other families\' photos, unknown packages and empty carts', () => {
    expect(() => priceCart(packages, { lines: [{ packageId: 'dig', qty: 1 }], digitalPhotoIds: ['zzz'], printSlots: [] }, 1800, photos)).toThrow('photo_not_in_booking');
    expect(() => priceCart(packages, { lines: [{ packageId: 'nope', qty: 1 }], digitalPhotoIds: [], printSlots: [] }, 1800, photos)).toThrow('unknown_package');
    expect(() => priceCart(packages, { lines: [], digitalPhotoIds: [], printSlots: [] }, 1800, photos)).toThrow('empty_cart');
    expect(() => priceCart(packages, { lines: [{ packageId: 'dig', qty: 0 }], digitalPhotoIds: ['a'], printSlots: [] }, 1800, photos)).toThrow('bad_qty');
  });
});
