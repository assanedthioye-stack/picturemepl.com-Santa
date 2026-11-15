import { describe, expect, it } from 'vitest';
import { can, validateSecret, PRINT_ROUTES } from './index';
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
  });
});

describe('i18n', () => {
  it('fr and en have the same keys', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(fr).sort());
  });
});
