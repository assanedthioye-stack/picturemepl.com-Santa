import { cinetpay } from './payments/cinetpay';
import { fakeProvider } from './payments/fake';
import { fedapay } from './payments/fedapay';
import { mtnMomo } from './payments/mtn';
import type { PaymentsConfig } from './payments/service';
import type { Provider, ProviderId } from './payments/types';

type Get = (k: string) => string | undefined;

/** Providers are enabled by their credentials; routing per country picks one for Wave/Orange (SN, CI) and MTN (BJ). */
export function paymentsFromEnv(get: Get): PaymentsConfig {
  const providers: Partial<Record<ProviderId, Provider>> = {};
  if (get('CINETPAY_APIKEY') && get('CINETPAY_SITE_ID')) {
    providers.cinetpay = cinetpay({ apiKey: get('CINETPAY_APIKEY')!, siteId: get('CINETPAY_SITE_ID')! });
  }
  if (get('FEDAPAY_SECRET_KEY')) providers.fedapay = fedapay({ secretKey: get('FEDAPAY_SECRET_KEY')!, sandbox: get('FEDAPAY_ENV') !== 'live' });
  if (get('MTN_SUBSCRIPTION_KEY') && get('MTN_API_USER') && get('MTN_API_KEY')) {
    providers.mtn = mtnMomo({
      baseUrl: get('MTN_BASE_URL') ?? 'https://sandbox.momodeveloper.mtn.com',
      subscriptionKey: get('MTN_SUBSCRIPTION_KEY')!, apiUser: get('MTN_API_USER')!, apiKey: get('MTN_API_KEY')!,
      targetEnvironment: get('MTN_TARGET_ENV') ?? 'sandbox',
    });
  }
  if (get('ALLOW_FAKE_PAYMENTS') === '1') providers.fake = fakeProvider();
  const route = (k: string, d: ProviderId) => (get(k) as ProviderId | undefined) ?? d;
  return {
    providers,
    route: { SN: route('PROVIDER_SN', 'cinetpay'), CI: route('PROVIDER_CI', 'cinetpay'), BJ: route('PROVIDER_BJ', 'mtn') },
    apiUrl: (get('API_PUBLIC_URL') ?? '').replace(/\/$/, ''),
    merchant: { mtn_momo: get('MTN_MERCHANT_MSISDN') ?? '2290159089346' },
  };
}
