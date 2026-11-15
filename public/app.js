const I = {
  fr: { lang: 'EN', pin: 'Code PIN', book_title: 'Photos avec le Père Noël', mall: 'Centre commercial', day: 'Jour', slots: 'Choisissez un créneau', full: 'Complet',
    name: 'Nom du parent', phone: 'Téléphone', consent: "Je consens à ce que mon enfant soit photographié et j'accepte que les photos soient conservées de façon privée (liens numériques valables 30 jours).",
    book: 'Réserver', your_code: 'Votre code', show_code: 'Présentez ce code ou ce QR code à l’accueil. Arrivée en retard de plus de 30 min : vous passerez comme sans rendez-vous.',
    cancel_t: 'Annuler une réservation', cancel: 'Annuler', cancelled: 'Réservation annulée', no_slots: 'Aucun créneau ce jour-là',
    e_full: 'Ce créneau est complet', e_consent: 'Le consentement est requis', 'e_no active family': 'Aucune famille en cours : appuyez sur « Suivant » à l’accueil', 'e_unknown code': 'Code inconnu',
    'e_invalid payment': 'Paiement incomplet ou invalide', 'e_unpaid order': 'Commande non payée', 'e_total changed': 'Le total a changé : rechargez', unpaid_confirm: 'Commande non payée. Passer quand même au suivant ?', dl: 'Télécharger vos photos', prices_auto: 'Prix (déjà chargés, à modifier seulement si besoin)', slots_title: 'Créer les créneaux', open_t: 'Ouverture', close_t: 'Fermeture', slot_len: 'Durée d’un créneau (minutes)', per_slot: 'Familles par créneau', create_slots: 'Créer les créneaux', slots_done: 'créneaux créés', local_time: 'Heures locales du centre commercial', add_mall: 'Ajouter un centre commercial', e_bad_slots: 'Vérifiez les dates, les heures et la durée', e_bad_mall: 'Nom ou pays invalide', trend: 'Chiffre d’affaires dans le temps', activity: 'Activité par jour', peak: 'Heures de pointe (arrivées)', s_book: 'Réservations', s_served: 'Servis', s_orders: 'Commandes', export_orders: 'Exporter les commandes (CSV)', export_daily: 'Exporter le résumé par jour (CSV)', export_hint: 'Ouvrir avec Excel', dash: 'Tableau de bord', all: 'Tous les pays', from: 'Du', to: 'Au', revenue: 'Chiffre d’affaires', orders: 'Commandes', avg_order: 'Panier moyen', conversion: 'Conversion (payé / servi)', noshow: 'Absences', avg_wait: 'Attente moyenne', fill: 'Remplissage des créneaux', by_day: 'Par jour', by_mall: 'Par centre', mix: 'Forfaits et suppléments', pay_split: 'Paiements', cashiers: 'Par caissier', funnel: 'Parcours', f_bookings: 'Réservations', f_walkins: 'Sans RDV', f_served: 'Servis', f_paid: 'Payés', discounts: 'Lignes à −20 %', min: 'min', e_pin: 'PIN incorrect', e_other: 'Erreur',
    scan: 'Scanner', code: 'Code', check_in: 'Enregistrer', walkin: 'Sans rendez-vous', add: 'Ajouter', next: 'Suivant', queue: 'File d’attente', empty: 'Personne en attente',
    appointment: 'RDV', walkin_k: 'Sans RDV', serving: 'En cours', now: 'En cours', photos: 'photos', waiting_family: 'En attente d’une famille…',
    pick: 'Touchez vos photos préférées', packages: 'Forfaits', extras: 'Suppléments', total: 'Total', pay_at: 'Pour payer, donnez ce code au caissier',
    essentiel: 'Essentiel', famille: 'Famille', prestige: 'Prestige', numerique: 'Numérique', print_8x10: 'Tirage 8×10', print_5x7: 'Tirage 5×7', print_4x6: '2 tirages 4×6', wallet: '8 mini (portefeuille)', digital: 'Fichier numérique',
    method: 'Mode de paiement', cash: 'Espèces', mobile_money: 'Mobile Money', provider: 'Opérateur', reference: 'Référence de transaction', received: 'Montant reçu', paid_btn: 'Payé', paid: 'Payé ✓', printing: 'Impression en cours',
    discount: '−20 %', admin_slots: 'Ajouter un créneau', start: 'Début', capacity: 'Capacité', prices: 'Prix', country: 'Pays', item: 'Article', amount: 'Montant', save: 'Enregistrer', sales: 'Ventes du jour' },
  en: { lang: 'FR', pin: 'PIN', book_title: 'Photos with Santa', mall: 'Mall', day: 'Day', slots: 'Choose a time slot', full: 'Full',
    name: 'Parent name', phone: 'Phone', consent: 'I consent to my child being photographed and agree the photos are kept privately (digital links valid for 30 days).',
    book: 'Book', your_code: 'Your code', show_code: 'Show this code or QR code at the desk. Arriving more than 30 min late: you will be treated as a walk-in.',
    cancel_t: 'Cancel a booking', cancel: 'Cancel', cancelled: 'Booking cancelled', no_slots: 'No slots that day',
    e_full: 'That slot is full', e_consent: 'Consent is required', 'e_no active family': 'No family is being served: press “Next” at the desk', 'e_unknown code': 'Unknown code',
    'e_invalid payment': 'Payment incomplete or invalid', 'e_unpaid order': 'Unpaid order', 'e_total changed': 'Total changed: reload', unpaid_confirm: 'Unpaid order. Move on to the next family anyway?', dl: 'Download your photos', prices_auto: 'Prices (already loaded, edit only if needed)', slots_title: 'Create time slots', open_t: 'Opens', close_t: 'Closes', slot_len: 'Slot length (minutes)', per_slot: 'Families per slot', create_slots: 'Create slots', slots_done: 'slots created', local_time: 'Local time at the mall', add_mall: 'Add a mall', e_bad_slots: 'Check the dates, hours and slot length', e_bad_mall: 'Invalid name or country', trend: 'Revenue over time', activity: 'Daily activity', peak: 'Peak hours (arrivals)', s_book: 'Bookings', s_served: 'Served', s_orders: 'Orders', export_orders: 'Export orders (CSV)', export_daily: 'Export daily summary (CSV)', export_hint: 'Opens in Excel', dash: 'Dashboard', all: 'All countries', from: 'From', to: 'To', revenue: 'Revenue', orders: 'Orders', avg_order: 'Average order', conversion: 'Conversion (paid / served)', noshow: 'No-shows', avg_wait: 'Average wait', fill: 'Slot fill rate', by_day: 'By day', by_mall: 'By mall', mix: 'Packages and extras', pay_split: 'Payments', cashiers: 'By cashier', funnel: 'Funnel', f_bookings: 'Bookings', f_walkins: 'Walk-ins', f_served: 'Served', f_paid: 'Paid', discounts: 'Lines at −20%', min: 'min', e_pin: 'Wrong PIN', e_other: 'Error',
    scan: 'Scan', code: 'Code', check_in: 'Check in', walkin: 'Walk-in', add: 'Add', next: 'Next', queue: 'Queue', empty: 'Nobody waiting',
    appointment: 'Booked', walkin_k: 'Walk-in', serving: 'Serving', now: 'Now serving', photos: 'photos', waiting_family: 'Waiting for a family…',
    pick: 'Tap your favourite photos', packages: 'Packages', extras: 'Extras', total: 'Total', pay_at: 'To pay, give this code to the cashier',
    essentiel: 'Essentiel', famille: 'Famille', prestige: 'Prestige', numerique: 'Digital', print_8x10: '8×10 print', print_5x7: '5×7 print', print_4x6: '2 × 4×6 prints', wallet: '8 wallets', digital: 'Digital file',
    method: 'Payment method', cash: 'Cash', mobile_money: 'Mobile Money', provider: 'Provider', reference: 'Transaction reference', received: 'Amount received', paid_btn: 'Paid', paid: 'Paid ✓', printing: 'Printing',
    discount: '−20%', admin_slots: 'Add a slot', start: 'Start', capacity: 'Capacity', prices: 'Prices', country: 'Country', item: 'Item', amount: 'Amount', save: 'Save', sales: 'Sales today' },
};
let LANG = 'fr'; try { LANG = localStorage.lang || 'fr'; } catch {}
const t = (k) => I[LANG][k] ?? I.fr[k] ?? k;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const xof = (n) => n.toLocaleString('fr-FR') + ' F';
const mall = new URLSearchParams(location.search).get('mall') || '1';
const PROVIDERS = { SN: ['Orange Money', 'Wave'], CI: ['Orange Money', 'Wave'], BJ: ['MTN MoMo', 'Celtiis Cash'] };

function applyI18n() {
  document.documentElement.lang = LANG;
  document.querySelectorAll('[data-t]').forEach((e) => (e.textContent = t(e.dataset.t)));
  document.querySelectorAll('[data-tp]').forEach((e) => (e.placeholder = t(e.dataset.tp)));
}
function toggleLang() { LANG = LANG === 'fr' ? 'en' : 'fr'; try { localStorage.lang = LANG; } catch {} applyI18n(); if (window.render) render(); }
function getPin() { let p = sessionStorage.pin; if (!p) { p = prompt(t('pin')) || ''; sessionStorage.pin = p; } return p; }
const errText = (m) => t('e_' + m) !== 'e_' + m ? t('e_' + m) : m;

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'x-pin': getPin(), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (r.status === 401) sessionStorage.removeItem('pin');
  if (!r.ok) throw new Error(r.status === 401 ? 'pin' : j?.error || 'other');
  return j;
}
const pub = async (method, url, body) => {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.error || 'other');
  return j;
};
const header = (title) => `<div class="top"><h1 data-t="${title}"></h1><button class="alt" onclick="toggleLang()" data-t="lang"></button></div>`;
