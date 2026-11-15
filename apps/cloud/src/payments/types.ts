export type ProviderId = 'cinetpay' | 'fedapay' | 'mtn' | 'fake';
export type Method = 'wave' | 'orange_money' | 'mtn_momo' | 'celtiis_cash';

export interface InitInput {
  paymentId: string;
  amountXof: number;
  method: Method;
  country: 'SN' | 'BJ' | 'CI';
  /** E.164, e.g. +2290197123456. Required for MTN push. */
  phone?: string;
  customerName?: string;
  description: string;
  notifyUrl: string;
  returnUrl: string;
}

/** Hosted checkout page (CinetPay, FedaPay) or a USSD prompt pushed to the payer's phone (MTN). */
export type InitResult =
  | { kind: 'redirect'; url: string; providerRef: string }
  | { kind: 'push'; providerRef: string };

export interface CheckResult {
  status: 'pending' | 'succeeded' | 'failed';
  /** The operator's transaction id shown on the customer's receipt, when the provider gives it. */
  operatorRef?: string;
  amountXof?: number;
  raw: unknown;
}

export interface Provider {
  id: ProviderId;
  init(i: InitInput): Promise<InitResult>;
  /** Source of truth: always asked before money counts, whatever a webhook said. */
  check(paymentId: string, providerRef: string): Promise<CheckResult>;
}

export type Fetch = typeof fetch;

export async function json<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new Error(`${what}_http_${res.status}: ${text.slice(0, 300)}`);
  return body as T;
}
