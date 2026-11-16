import { useEffect, useState } from 'preact/hooks';
import { store } from './api';

const fr = {
  'title': 'Picture Me Please',
  'tagline': 'Votre photo avec le Père Noël, réservée en 1 minute.',
  'step': 'Étape',
  'back': 'Retour',
  'country.title': 'Dans quel pays ?',
  'venue.title': 'Quel centre commercial ?',
  'venue.none': 'Aucun événement ouvert pour le moment dans ce pays.',
  'slot.title': 'Quel jour et à quelle heure ?',
  'slot.none': 'Plus de créneau libre ce jour-là.',
  'package.title': 'Quelle formule ?',
  'details.title': 'Vos coordonnées',
  'details.name': 'Nom de la famille',
  'details.phone': 'Téléphone (WhatsApp)',
  'details.phoneCountry': 'Indicatif',
  'details.party': 'Nombre de personnes',
  'details.submit': 'Réserver et payer',
  'details.hold': 'Le créneau vous est réservé 15 minutes le temps du paiement.',
  'pay.title': 'Paiement',
  'pay.with': 'Payer avec',
  'pay.phone': 'Numéro MTN MoMo qui paie',
  'pay.go': 'Payer',
  'pay.push': 'Validez le paiement sur votre téléphone (notification MTN MoMo).',
  'pay.waiting': 'Paiement en cours de confirmation…',
  'pay.failed': 'Le paiement n\'a pas abouti. Vous pouvez réessayer.',
  'pay.slow': 'Le paiement n\'est pas encore confirmé. Si vous avez payé, rechargez cette page dans quelques minutes ; sinon vous pouvez réessayer.',
  'pay.wave': 'Wave', 'pay.orange_money': 'Orange Money', 'pay.mtn_momo': 'MTN MoMo',
  'ticket.title': 'Votre billet',
  'ticket.confirmed': 'Réservation confirmée',
  'ticket.code': 'Code de réservation',
  'ticket.show': 'Montrez ce QR code à l\'accueil du stand.',
  'ticket.pin': 'Code PIN de la galerie',
  'ticket.pin.keep': 'Gardez-le : il ouvre vos photos après la séance.',
  'ticket.download': 'Télécharger le billet',
  'ticket.share': 'Partager sur WhatsApp',
  'ticket.people': 'pers.',
  'gallery.title': 'Vos photos',
  'gallery.pin': 'Entrez votre code PIN (6 chiffres)',
  'gallery.open': 'Voir mes photos',
  'gallery.wrong': 'Code PIN incorrect.',
  'gallery.locked': 'Trop d\'essais. Réessayez dans 15 minutes.',
  'gallery.hint': 'Aperçus filigranés. Choisissez les photos à télécharger en haute définition.',
  'gallery.unlock': 'Débloquer',
  'gallery.photos': 'photo(s)',
  'gallery.download': 'Télécharger',
  'gallery.share': 'Partager',
  'gallery.preparing': 'Haute définition en préparation…',
  'gallery.close': 'Fermer',
  'gallery.select': 'Choisir',
  'gallery.selected': 'Choisie',
  'thanks': 'Merci ! Le paiement est enregistré. Vous pouvez fermer cette page.',
  'error': 'Une erreur est survenue. Réessayez.',
  'err.slot_full': 'Ce créneau vient d\'être pris. Choisissez-en un autre.',
  'err.invalid_phone': 'Numéro de téléphone invalide.',
  'err.booking_not_found': 'Réservation introuvable.',
  'err.provider_error': 'Le service de paiement ne répond pas. Réessayez dans un instant.',
};
type Key = keyof typeof fr;
const en: Record<Key, string> = {
  'title': 'Picture Me Please',
  'tagline': 'Your photo with Santa, booked in 1 minute.',
  'step': 'Step',
  'back': 'Back',
  'country.title': 'Which country?',
  'venue.title': 'Which mall?',
  'venue.none': 'No event open in this country right now.',
  'slot.title': 'Which day and time?',
  'slot.none': 'No free time left that day.',
  'package.title': 'Which package?',
  'details.title': 'Your details',
  'details.name': 'Family name',
  'details.phone': 'Phone (WhatsApp)',
  'details.phoneCountry': 'Country code',
  'details.party': 'People',
  'details.submit': 'Book and pay',
  'details.hold': 'The time slot is held for you for 15 minutes while you pay.',
  'pay.title': 'Payment',
  'pay.with': 'Pay with',
  'pay.phone': 'MTN MoMo number paying',
  'pay.go': 'Pay',
  'pay.push': 'Approve the payment on your phone (MTN MoMo prompt).',
  'pay.waiting': 'Confirming your payment…',
  'pay.failed': 'The payment did not go through. You can try again.',
  'pay.slow': 'The payment is not confirmed yet. If you have paid, reload this page in a few minutes; otherwise you can try again.',
  'pay.wave': 'Wave', 'pay.orange_money': 'Orange Money', 'pay.mtn_momo': 'MTN MoMo',
  'ticket.title': 'Your ticket',
  'ticket.confirmed': 'Booking confirmed',
  'ticket.code': 'Booking code',
  'ticket.show': 'Show this QR code at the booth desk.',
  'ticket.pin': 'Gallery PIN',
  'ticket.pin.keep': 'Keep it: it opens your photos after the shoot.',
  'ticket.download': 'Download ticket',
  'ticket.share': 'Share on WhatsApp',
  'ticket.people': 'people',
  'gallery.title': 'Your photos',
  'gallery.pin': 'Enter your PIN (6 digits)',
  'gallery.open': 'See my photos',
  'gallery.wrong': 'Wrong PIN.',
  'gallery.locked': 'Too many attempts. Try again in 15 minutes.',
  'gallery.hint': 'Watermarked previews. Choose the photos to download in high resolution.',
  'gallery.unlock': 'Unlock',
  'gallery.photos': 'photo(s)',
  'gallery.download': 'Download',
  'gallery.share': 'Share',
  'gallery.preparing': 'High resolution on its way…',
  'gallery.close': 'Close',
  'gallery.select': 'Select',
  'gallery.selected': 'Selected',
  'thanks': 'Thank you! Your payment is recorded. You can close this page.',
  'error': 'Something went wrong. Please try again.',
  'err.slot_full': 'This time was just taken. Please pick another.',
  'err.invalid_phone': 'Invalid phone number.',
  'err.booking_not_found': 'Booking not found.',
  'err.provider_error': 'The payment service is not answering. Try again in a moment.',
};

export type Locale = 'fr' | 'en';
let current: Locale = store.get('pmp.locale') === 'en' || (!store.get('pmp.locale') && navigator.language.startsWith('en')) ? 'en' : 'fr';
const listeners = new Set<() => void>();

export function setLocale(l: Locale) {
  current = l;
  document.documentElement.lang = l;
  store.set('pmp.locale', l);
  listeners.forEach((f) => f());
}

export function useT() {
  const [, force] = useState(0);
  useEffect(() => { const f = () => force((n) => n + 1); listeners.add(f); return () => { listeners.delete(f); }; }, []);
  const dict = current === 'fr' ? fr : en;
  const t = (k: Key) => dict[k];
  const err = (e: unknown) => { const k = `err.${(e as Error)?.message}` as Key; return dict[k] ?? dict.error; };
  return { t, err, locale: current };
}

export const money = (l: Locale, xof: number) =>
  new Intl.NumberFormat(l === 'fr' ? 'fr-FR' : 'en-GB', { style: 'currency', currency: 'XOF', maximumFractionDigits: 0 }).format(xof);
