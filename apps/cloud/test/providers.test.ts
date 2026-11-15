import { describe, expect, it } from 'vitest';
import { cinetpay } from '../src/payments/cinetpay';
import { fedapay } from '../src/payments/fedapay';
import { mtnMomo } from '../src/payments/mtn';
import type { InitInput } from '../src/payments/types';

type Call = { url: string; init: RequestInit };
function mockFetch(responder: (c: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const c = { url: String(url), init };
    calls.push(c);
    const r = responder(c);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { f, calls };
}
const input: InitInput = {
  paymentId: 'pay-1', amountXof: 10_000, method: 'wave', country: 'SN', phone: '+221771234567', customerName: 'Famille Diop',
  description: 'Picture Me Please', notifyUrl: 'https://api.test/api/webhooks/x', returnUrl: 'https://web.test/b/tok?paid=1',
};
const body = (c: Call) => JSON.parse(String(c.init.body));

describe('CinetPay', () => {
  it('creates a hosted payment and reads the check endpoint', async () => {
    const { f, calls } = mockFetch((c) => c.url.endsWith('/payment')
      ? { body: { code: '201', message: 'CREATED', data: { payment_url: 'https://checkout.cinetpay.com/payment/abc', payment_token: 'tok123' } } }
      : { body: { code: '00', data: { status: 'ACCEPTED', amount: '10000', operator_id: 'MP2611.1234.A' } } });
    const p = cinetpay({ apiKey: 'K', siteId: '555', fetch: f });
    expect(await p.init(input)).toEqual({ kind: 'redirect', url: 'https://checkout.cinetpay.com/payment/abc', providerRef: 'tok123' });
    expect(calls[0]!.url).toBe('https://api-checkout.cinetpay.com/v2/payment');
    expect(body(calls[0]!)).toMatchObject({
      apikey: 'K', site_id: '555', transaction_id: 'pay-1', amount: 10_000, currency: 'XOF',
      notify_url: 'https://api.test/api/webhooks/x', return_url: 'https://web.test/b/tok?paid=1', customer_phone_number: '+221771234567',
    });
    expect(await p.check('pay-1', 'tok123')).toMatchObject({ status: 'succeeded', amountXof: 10_000, operatorRef: 'MP2611.1234.A' });
    expect(body(calls[1]!)).toEqual({ apikey: 'K', site_id: '555', transaction_id: 'pay-1' });
  });
  it('maps refused and waiting, and surfaces init errors', async () => {
    const refused = cinetpay({ apiKey: 'K', siteId: '1', fetch: mockFetch(() => ({ status: 400, body: { code: '600', data: { status: 'REFUSED' } } })).f });
    expect((await refused.check('x', 'y')).status).toBe('failed');
    const waiting = cinetpay({ apiKey: 'K', siteId: '1', fetch: mockFetch(() => ({ body: { code: '662', data: { status: 'WAITING_FOR_CUSTOMER' } } })).f });
    expect((await waiting.check('x', 'y')).status).toBe('pending');
    const bad = cinetpay({ apiKey: 'K', siteId: '1', fetch: mockFetch(() => ({ body: { code: '608', message: 'MINIMUM_REQUIRED_FIELDS' } })).f });
    await expect(bad.init(input)).rejects.toThrow('cinetpay_init_608');
  });
});

describe('FedaPay', () => {
  it('creates a transaction, gets its checkout token, then reads its status', async () => {
    const { f, calls } = mockFetch((c) => c.url.endsWith('/transactions') ? { body: { 'v1/transaction': { id: 4242, status: 'pending', amount: 10000 } } }
      : c.url.endsWith('/token') ? { body: { token: 't', url: 'https://process.fedapay.com/t' } }
      : { body: { 'v1/transaction': { id: 4242, status: 'approved', amount: 10000, reference: 'trx_ABC' } } });
    const p = fedapay({ secretKey: 'sk_sandbox_x', sandbox: true, fetch: f });
    expect(await p.init({ ...input, country: 'CI', phone: '+2250707123456' })).toEqual({ kind: 'redirect', url: 'https://process.fedapay.com/t', providerRef: '4242' });
    expect(calls[0]!.url).toBe('https://sandbox-api.fedapay.com/v1/transactions');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer sk_sandbox_x');
    expect(body(calls[0]!)).toMatchObject({
      amount: 10_000, currency: { iso: 'XOF' }, merchant_reference: 'pay-1', callback_url: 'https://web.test/b/tok?paid=1',
      customer: { phone_number: { number: '2250707123456', country: 'ci' } },
    });
    expect(calls[1]!.url).toBe('https://sandbox-api.fedapay.com/v1/transactions/4242/token');
    expect(await p.check('pay-1', '4242')).toMatchObject({ status: 'succeeded', operatorRef: 'trx_ABC', amountXof: 10_000 });
    expect(calls[2]!.url).toBe('https://sandbox-api.fedapay.com/v1/transactions/4242');
  });
});

describe('MTN MoMo Collections', () => {
  const cfg = { baseUrl: 'https://proxy.momoapi.mtn.com', subscriptionKey: 'SUB', apiUser: 'user-uuid', apiKey: 'secret', targetEnvironment: 'mtnbenin' };
  it('gets a token once, sends request-to-pay in XOF, polls the status', async () => {
    const { f, calls } = mockFetch((c) => c.url.endsWith('/collection/token/') ? { body: { access_token: 'AT', expires_in: 3600 } }
      : c.url.endsWith('/requesttopay') ? { status: 202, body: undefined }
      : { body: { status: 'SUCCESSFUL', financialTransactionId: '987654321', amount: '8500', currency: 'XOF' } });
    const p = mtnMomo({ ...cfg, fetch: f });
    const r = await p.init({ ...input, method: 'mtn_momo', country: 'BJ', amountXof: 8_500, phone: '+2290197123456' });
    expect(r.kind).toBe('push');
    const tokenCall = calls[0]!, rtp = calls[1]!;
    expect((tokenCall.init.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa('user-uuid:secret')}`);
    const h = rtp.init.headers as Record<string, string>;
    expect(h).toMatchObject({ Authorization: 'Bearer AT', 'X-Target-Environment': 'mtnbenin', 'Ocp-Apim-Subscription-Key': 'SUB', 'X-Callback-Url': input.notifyUrl });
    expect(h['X-Reference-Id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(body(rtp)).toEqual({
      amount: '8500', currency: 'XOF', externalId: 'pay-1', payer: { partyIdType: 'MSISDN', partyId: '2290197123456' },
      payerMessage: 'Picture Me Please', payeeNote: 'Picture Me Please',
    });
    expect(await p.check('pay-1', r.providerRef)).toMatchObject({ status: 'succeeded', operatorRef: '987654321', amountXof: 8_500 });
    expect(calls[2]!.url).toBe(`https://proxy.momoapi.mtn.com/collection/v1_0/requesttopay/${r.providerRef}`);
    expect(calls.filter((c) => c.url.endsWith('/token/'))).toHaveLength(1); // token reused
  });
  it('uses EUR and no callback in the sandbox; maps failures', async () => {
    const { f, calls } = mockFetch((c) => c.url.endsWith('/token/') ? { body: { access_token: 'AT', expires_in: 3600 } }
      : c.url.endsWith('/requesttopay') ? { status: 202, body: undefined } : { body: { status: 'FAILED', reason: 'APPROVAL_REJECTED' } });
    const p = mtnMomo({ ...cfg, targetEnvironment: 'sandbox', fetch: f });
    const r = await p.init({ ...input, method: 'mtn_momo', country: 'BJ', phone: '+2290197123456' });
    expect(body(calls[1]!).currency).toBe('EUR');
    expect((calls[1]!.init.headers as Record<string, string>)['X-Callback-Url']).toBeUndefined();
    expect((await p.check('pay-1', r.providerRef)).status).toBe('failed');
    await expect(p.init({ ...input, phone: undefined })).rejects.toThrow('phone_required');
  });
});
