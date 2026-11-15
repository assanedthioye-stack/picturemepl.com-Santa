import type { Provider } from './types';

/**
 * DEV/DEMO ONLY (ALLOW_FAKE_PAYMENTS=1): approves every payment, except phones ending in 0000 which are refused.
 * Redirect flows go straight back to the return URL; MTN-style flows "push".
 */
export function fakeProvider(): Provider {
  const failed = new Set<string>();
  return {
    id: 'fake',
    async init(i) {
      if (i.phone?.endsWith('0000')) failed.add(i.paymentId);
      return i.method === 'mtn_momo'
        ? { kind: 'push', providerRef: `fake-${i.paymentId}` }
        : { kind: 'redirect', url: i.returnUrl, providerRef: `fake-${i.paymentId}` };
    },
    async check(paymentId) {
      return failed.has(paymentId)
        ? { status: 'failed', raw: { fake: true } }
        : { status: 'succeeded', operatorRef: `FAKE${paymentId.slice(-6).toUpperCase()}`, raw: { fake: true } };
    },
  };
}
