import { randomBytes, randomInt } from 'node:crypto';

/** UUIDv7: time-ordered, generated on the device (no collisions across booths). */
export function uuidv7(): string {
  const b = randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Human code without look-alike characters (no I, L, O, U). */
export function humanCode(length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += CROCKFORD[randomInt(CROCKFORD.length)];
  return s;
}
