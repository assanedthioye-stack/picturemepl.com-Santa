import { json, type Fetch, type Provider } from './types';

/**
 * CinetPay Checkout API v2 (Wave, Orange Money… in Senegal and Côte d'Ivoire).
 * Init returns a hosted payment page; the notify_url ping is only a hint — status comes from /payment/check.
 */
export function cinetpay(o: { apiKey: string; siteId: string; baseUrl?: string; fetch?: Fetch }): Provider {
  const base = o.baseUrl ?? 'https://api-checkout.cinetpay.com/v2';
  const f = o.fetch ?? fetch;
  const post = (path: string, body: object) =>
    f(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return {
    id: 'cinetpay',
    async init(i) {
      const r = await json<{ code: string; message: string; data?: { payment_url: string; payment_token: string } }>(await post('/payment', {
        apikey: o.apiKey, site_id: o.siteId, transaction_id: i.paymentId, amount: i.amountXof, currency: 'XOF',
        description: i.description, notify_url: i.notifyUrl, return_url: i.returnUrl, channels: 'ALL',
        lang: 'fr', ...(i.phone ? { customer_phone_number: i.phone } : {}), ...(i.customerName ? { customer_name: i.customerName } : {}),
      }), 'cinetpay_init');
      if (r.code !== '201' || !r.data) throw new Error(`cinetpay_init_${r.code}: ${r.message}`);
      return { kind: 'redirect', url: r.data.payment_url, providerRef: r.data.payment_token };
    },
    async check(paymentId) {
      const res = await post('/payment/check', { apikey: o.apiKey, site_id: o.siteId, transaction_id: paymentId });
      // CinetPay answers non-2xx with a JSON body for "not paid yet"; read the body either way.
      const r = (await res.json().catch(() => ({}))) as { code?: string; data?: { status?: string; amount?: string; operator_id?: string | null } };
      const s = (r.data?.status ?? '').toUpperCase();
      return {
        status: s === 'ACCEPTED' ? 'succeeded' : s === 'REFUSED' || s.startsWith('CANCEL') ? 'failed' : 'pending',
        operatorRef: r.data?.operator_id ?? undefined,
        amountXof: r.data?.amount !== undefined ? Number(r.data.amount) : undefined,
        raw: r,
      };
    },
  };
}
