import { json, type Fetch, type Provider } from './types';

type Tx = { id: number; status: string; amount: number; reference?: string; transaction_key?: string };

/** FedaPay (Wave / Orange Money / MTN… depending on the merchant account). Hosted checkout + webhook hint. */
export function fedapay(o: { secretKey: string; sandbox?: boolean; baseUrl?: string; fetch?: Fetch }): Provider {
  const base = o.baseUrl ?? (o.sandbox ? 'https://sandbox-api.fedapay.com/v1' : 'https://api.fedapay.com/v1');
  const f = o.fetch ?? fetch;
  const call = (method: string, path: string, body?: object) => f(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${o.secretKey}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    id: 'fedapay',
    async init(i) {
      const phone = i.phone?.replace(/^\+/, '');
      const created = await json<{ 'v1/transaction': Tx }>(await call('POST', '/transactions', {
        description: i.description, amount: i.amountXof, currency: { iso: 'XOF' },
        callback_url: i.returnUrl, merchant_reference: i.paymentId,
        customer: {
          firstname: i.customerName ?? 'Client',
          ...(phone ? { phone_number: { number: phone, country: i.country.toLowerCase() } } : {}),
        },
      }), 'fedapay_create');
      const tx = created['v1/transaction'];
      const token = await json<{ token: string; url: string }>(await call('POST', `/transactions/${tx.id}/token`), 'fedapay_token');
      return { kind: 'redirect', url: token.url, providerRef: String(tx.id) };
    },
    async check(_paymentId, providerRef) {
      const tx = (await json<{ 'v1/transaction': Tx }>(await call('GET', `/transactions/${providerRef}`), 'fedapay_get'))['v1/transaction'];
      const s = tx.status;
      return {
        status: s === 'approved' || s === 'transferred' ? 'succeeded' : ['declined', 'canceled', 'refunded', 'expired'].includes(s) ? 'failed' : 'pending',
        operatorRef: tx.reference ?? tx.transaction_key,
        amountXof: tx.amount,
        raw: tx,
      };
    },
  };
}
