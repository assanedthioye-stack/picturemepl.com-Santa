import { describe, expect, it } from 'vitest';
import { can, extractBookingCode, normalizePhone, validateSecret, PRINT_ROUTES } from './index';
import fr from './i18n/fr.json';
import en from './i18n/en.json';

describe('rbac', () => {
  it('scopes roles', () => {
    expect(can('photographer', 'session.shoot')).toBe(true);
    expect(can('cashier', 'session.shoot')).toBe(false);
    expect(can('cashier', 'print.create')).toBe(true);
    expect(can('host', 'print.create')).toBe(false);
    expect(can('kiosk', 'kiosk.favorite')).toBe(true);
    expect(can('admin', 'kiosk.favorite')).toBe(false);
    expect(can('supervisor', 'refund.approve')).toBe(true);
    expect(can('cashier', 'refund.approve')).toBe(false);
  });
  it('validates secrets per role', () => {
    expect(validateSecret('cashier', '1234')).toBeNull();
    expect(validateSecret('cashier', '12a4')).not.toBeNull();
    expect(validateSecret('cashier', '123')).not.toBeNull();
    expect(validateSecret('admin', '123456')).not.toBeNull();
    expect(validateSecret('admin', 'long-enough-pass')).toBeNull();
  });
});

describe('print routes', () => {
  it('sends small prints to the DNP and large to the PIXMA', () => {
    expect(PRINT_ROUTES['4x6']).toBe('dnp');
    expect(PRINT_ROUTES['5x7']).toBe('dnp');
    expect(PRINT_ROUTES['8x10']).toBe('pixma');
    expect(PRINT_ROUTES.custom).toBe('pixma');
    expect(PRINT_ROUTES.wallet4).toBe('dnp');
  });
});

describe('i18n', () => {
  it('fr and en have the same keys', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(fr).sort());
  });
});

describe('phones and codes', () => {
  it('normalizes SN/BJ/CI numbers to E.164', () => {
    expect(normalizePhone('SN', '77 123 45 67')).toBe('+221771234567');
    expect(normalizePhone('SN', '+221 77 123 45 67')).toBe('+221771234567');
    expect(normalizePhone('SN', '0022177123456')).toBeNull(); // one digit short
    expect(normalizePhone('BJ', '01 97 12 34 56')).toBe('+2290197123456');
    expect(normalizePhone('CI', '07 07 12 34 56')).toBe('+2250707123456');
    expect(normalizePhone('CI', '07071234')).toBeNull();
    expect(normalizePhone('SN', '77abc4567')).toBeNull();
  });
  it('extracts the booking code from scans', () => {
    expect(extractBookingCode('482913')).toBe('482913');
    expect(extractBookingCode('https://picturemeplease.app/b/xyz?code=482913')).toBe('482913');
    expect(extractBookingCode('1234567')).toBeNull();
    expect(extractBookingCode('12345')).toBeNull();
  });
});
