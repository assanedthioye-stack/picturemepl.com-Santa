import { json, type Fetch, type Provider } from './types';

export interface MtnConfig {
  baseUrl: string;             // sandbox: https://sandbox.momodeveloper.mtn.com — live: https://proxy.momoapi.mtn.com
  subscriptionKey: string;     // Collections product primary key (Ocp-Apim-Subscription-Key)
  apiUser: string;             // API user UUID bound to the merchant's collection account
  apiKey: string;
  targetEnvironment: string;   // 'sandbox' or 'mtnbenin'
  fetch?: Fetch;
}

/**
 * MTN MoMo Collections API: request-to-pay pushes a USSD/approval prompt to the payer's phone.
 * The funds land in the collection account bound to the API user (not to a phone number we pass).
 */
export function mtnMomo(o: MtnConfig): Provider {
  const f = o.fetch ?? fetch;
  const currency = o.targetEnvironment === 'sandbox' ? 'EUR' : 'XOF'; // the sandbox only accepts EUR
  let token: { value: string; exp: number } | null = null;

  async function accessToken(): Promise<string> {
    if (token && token.exp > Date.now() + 60_000) return token.value;
    const r = await json<{ access_token: string; expires_in: number }>(await f(`${o.baseUrl}/collection/token/`, {
      method: 'POST',
      headers: { Authorization: `Basic ${btoa(`${o.apiUser}:${o.apiKey}`)}`, 'Ocp-Apim-Subscription-Key': o.subscriptionKey },
    }), 'mtn_token');
    token = { value: r.access_token, exp: Date.now() + r.expires_in * 1000 };
    return token.value;
  }
  const headers = async (extra: Record<string, string> = {}) => ({
    Authorization: `Bearer ${await accessToken()}`,
    'X-Target-Environment': o.targetEnvironment,
    'Ocp-Apim-Subscription-Key': o.subscriptionKey,
    ...extra,
  });

  return {
    id: 'mtn',
    async init(i) {
      if (!i.phone) throw new Error('phone_required');
      const referenceId = crypto.randomUUID(); // MTN wants a UUIDv4 X-Reference-Id
      const res = await f(`${o.baseUrl}/collection/v1_0/requesttopay`, {
        method: 'POST',
        headers: await headers({
          'X-Reference-Id': referenceId, 'content-type': 'application/json',
          // MTN only calls back to HTTPS hosts registered on the API user; the sandbox never calls back.
          ...(o.targetEnvironment !== 'sandbox' ? { 'X-Callback-Url': i.notifyUrl } : {}),
        }),
        body: JSON.stringify({
          amount: String(i.amountXof), currency, externalId: i.paymentId,
          payer: { partyIdType: 'MSISDN', partyId: i.phone.replace(/^\+/, '') },
          payerMessage: i.description.slice(0, 160), payeeNote: i.description.slice(0, 160),
        }),
      });
      if (res.status !== 202) throw new Error(`mtn_requesttopay_http_${res.status}: ${(await res.text()).slice(0, 300)}`);
      return { kind: 'push', providerRef: referenceId };
    },
    async check(_paymentId, providerRef) {
      const r = await json<{ status: string; financialTransactionId?: string; amount?: string; reason?: unknown }>(
        await f(`${o.baseUrl}/collection/v1_0/requesttopay/${providerRef}`, { headers: await headers() }), 'mtn_status');
      return {
        status: r.status === 'SUCCESSFUL' ? 'succeeded' : r.status === 'PENDING' ? 'pending' : 'failed',
        operatorRef: r.financialTransactionId,
        amountXof: r.amount !== undefined ? Number(r.amount) : undefined,
        raw: r,
      };
    },
  };
}
