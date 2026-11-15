import { useEffect, useMemo, useState } from 'preact/hooks';
import { COUNTRIES, type Country } from '@pmp/shared/src/phone';
import { PRINT_LABEL } from '@pmp/shared/src/print';
import { api, navigate, store, TIME_ZONES } from './api';
import { money, useT } from './i18n';

interface Venue { venueId: string; name: string; city: string; eventId: string; eventFr: string; eventEn: string; startsOn: string; endsOn: string }
interface Slot { id: string; startsAt: number; available: number }
interface Pkg { id: string; code: string; nameFr: string; nameEn: string; priceXof: number; digitalsIncluded: number; prints: Record<string, number> }

const FLAGS: Record<Country, string> = { SN: '🇸🇳', BJ: '🇧🇯', CI: '🇨🇮' };

/** "YYYY-MM-DD" in the venue's time zone, `plus` days from today. */
function localDate(country: Country, plus = 0): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONES[country] }).format(new Date(Date.now() + plus * 86_400_000));
}

export function Book() {
  const { t, err, locale } = useT();
  const [country, setCountry] = useState<Country | null>(null);
  const [venues, setVenues] = useState<Venue[] | null>(null);
  const [venue, setVenue] = useState<Venue | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [pkgs, setPkgs] = useState<Pkg[]>([]);
  const [pkg, setPkg] = useState<Pkg | null>(null);
  const [form, setForm] = useState({ fullName: '', phone: '', phoneCountry: 'SN' as Country, partySize: 2 });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  const step = !country ? 1 : !venue ? 2 : !slot ? 3 : !pkg ? 4 : 5;
  const back = () => { setError(null); if (pkg) setPkg(null); else if (slot) setSlot(null); else if (venue) { setVenue(null); setDate(null); } else setCountry(null); };

  useEffect(() => {
    if (!country) return;
    setVenues(null);
    setForm((f) => ({ ...f, phoneCountry: country }));
    api<Venue[]>('GET', `/api/venues?country=${country}`).then(setVenues, () => setVenues([]));
    api<Pkg[]>('GET', `/api/packages?country=${country}`).then(setPkgs, () => {});
  }, [country]);

  // Dates the family can pick: from today (or the event start) up to 14 days.
  const dates = useMemo(() => {
    if (!venue || !country) return [];
    const out: string[] = [];
    for (let i = 0; i < 120 && out.length < 14; i++) {
      const d = localDate(country, i);
      if (d > venue.endsOn) break;
      if (d >= venue.startsOn) out.push(d);
    }
    return out;
  }, [venue, country]);
  useEffect(() => { if (dates.length && !date) setDate(dates[0]!); }, [dates]);

  useEffect(() => {
    if (!venue || !date) return;
    setSlots(null);
    api<Slot[]>('GET', `/api/slots?eventId=${venue.eventId}&date=${date}`).then((list) => {
      // Several booths can share a time: keep one, preferably with room.
      const byTime = new Map<number, Slot>();
      for (const s of list) { const prev = byTime.get(s.startsAt); if (!prev || (prev.available === 0 && s.available > 0)) byTime.set(s.startsAt, s); }
      setSlots([...byTime.values()]);
    }, () => setSlots([]));
  }, [venue, date, reload]);

  const tz = country ? TIME_ZONES[country] : 'UTC';
  const lang = locale === 'fr' ? 'fr-FR' : 'en-GB';
  const time = (ms: number) => new Intl.DateTimeFormat(lang, { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(ms);
  const day = (d: string) => new Intl.DateTimeFormat(lang, { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(Date.parse(`${d}T00:00:00Z`));
  const contents = (p: Pkg) => [
    ...Object.entries(p.prints).map(([s, n]) => (s === 'wallet4' ? `${n * 4} ${locale === 'fr' ? 'portefeuilles' : 'wallets'}` : `${n} × ${PRINT_LABEL[s as keyof typeof PRINT_LABEL]}`)),
    p.digitalsIncluded === -1 ? (locale === 'fr' ? 'tous les fichiers numériques' : 'all digital files')
      : p.digitalsIncluded > 0 ? `${p.digitalsIncluded} ${locale === 'fr' ? 'fichier numérique HD' : 'HD digital file'}` : '',
  ].filter(Boolean).join(' · ');

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string; pin: string }>('POST', '/api/bookings', { slotId: slot!.id, packageCode: pkg!.code, locale, ...form });
      store.set(`pmp.pin.${r.token}`, r.pin); // shown on the ticket; the server keeps only a hash
      navigate(`/b/${r.token}`);
    } catch (ex) {
      setError(err(ex));
      if ((ex as Error).message === 'slot_full') { setSlot(null); setReload((n) => n + 1); } // show fresh availability
    } finally {
      setBusy(false);
    }
  }

  const card = 'w-full rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm active:bg-slate-50';
  const input = 'w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-lg focus:border-brand-600 focus:outline-none';

  return (
    <main class="mx-auto flex max-w-md flex-col gap-4 px-4 pb-10 pt-4">
      {step === 1 && <p class="text-lg text-slate-600">{t('tagline')}</p>}
      <div class="flex items-center gap-3 text-sm text-slate-500">
        {step > 1 && <button onClick={back} class="rounded-lg border border-slate-300 px-3 py-1.5 font-medium text-slate-700">← {t('back')}</button>}
        <span>{t('step')} {step}/5</span>
      </div>

      {step === 1 && (
        <section class="flex flex-col gap-3">
          <h1 class="text-2xl font-bold">{t('country.title')}</h1>
          {(Object.keys(COUNTRIES) as Country[]).map((c) => (
            <button key={c} onClick={() => setCountry(c)} class={`${card} flex items-center gap-4 text-xl font-semibold`}>
              <span class="text-3xl" aria-hidden>{FLAGS[c]}</span>{locale === 'fr' ? COUNTRIES[c].nameFr : COUNTRIES[c].nameEn}
            </button>
          ))}
        </section>
      )}

      {step === 2 && (
        <section class="flex flex-col gap-3">
          <h1 class="text-2xl font-bold">{t('venue.title')}</h1>
          {venues === null && <p class="text-slate-500" role="status">…</p>}
          {venues?.length === 0 && <p class="text-slate-600">{t('venue.none')}</p>}
          {venues?.map((v) => (
            <button key={v.eventId} onClick={() => setVenue(v)} class={card}>
              <p class="text-lg font-semibold">{v.name}</p>
              <p class="text-slate-500">{v.city} · {locale === 'fr' ? v.eventFr : v.eventEn}</p>
            </button>
          ))}
        </section>
      )}

      {step === 3 && venue && (
        <section class="flex flex-col gap-3">
          <h1 class="text-2xl font-bold">{t('slot.title')}</h1>
          <p class="text-slate-500">{venue.name}, {venue.city}</p>
          <div class="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1" role="tablist">
            {dates.map((d) => (
              <button key={d} role="tab" aria-selected={d === date} onClick={() => setDate(d)}
                class={`shrink-0 rounded-xl border px-3 py-2 text-sm font-semibold first-letter:uppercase ${d === date ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 bg-white'}`}>{day(d)}</button>
            ))}
          </div>
          {slots === null && <p class="text-slate-500" role="status">…</p>}
          {slots?.length === 0 || (slots && slots.every((s) => s.available === 0)) ? <p class="text-slate-600">{t('slot.none')}</p> : null}
          <div class="grid grid-cols-4 gap-2">
            {slots?.map((s) => (
              <button key={s.id} disabled={s.available === 0} onClick={() => setSlot(s)}
                class="rounded-xl border border-slate-300 bg-white py-3 font-semibold disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-300 disabled:line-through">
                {time(s.startsAt)}
              </button>
            ))}
          </div>
        </section>
      )}

      {step === 4 && (
        <section class="flex flex-col gap-3">
          <h1 class="text-2xl font-bold">{t('package.title')}</h1>
          {pkgs.map((p) => (
            <button key={p.id} onClick={() => setPkg(p)} class={card}>
              <div class="flex items-baseline justify-between gap-2">
                <p class="text-lg font-semibold">{locale === 'fr' ? p.nameFr : p.nameEn}</p>
                <p class="text-lg font-bold text-brand-600">{money(locale, p.priceXof)}</p>
              </div>
              <p class="text-sm text-slate-500">{contents(p)}</p>
            </button>
          ))}
        </section>
      )}

      {step === 5 && venue && slot && pkg && country && (
        <form onSubmit={submit} class="flex flex-col gap-4">
          <h1 class="text-2xl font-bold">{t('details.title')}</h1>
          <p class="rounded-xl bg-white p-3 text-sm text-slate-600 shadow-sm">
            {venue.name} · <span>{day(date!)}</span> {time(slot.startsAt)} · {locale === 'fr' ? pkg.nameFr : pkg.nameEn} · <b>{money(locale, pkg.priceXof)}</b>
          </p>
          <label class="flex flex-col gap-1 text-sm text-slate-600">{t('details.name')}
            <input required minLength={2} autoComplete="family-name" value={form.fullName} onInput={(e) => setForm({ ...form, fullName: e.currentTarget.value })} class={input} />
          </label>
          <div class="flex gap-2">
            <label class="flex flex-col gap-1 text-sm text-slate-600">{t('details.phoneCountry')}
              <select value={form.phoneCountry} onChange={(e) => setForm({ ...form, phoneCountry: e.currentTarget.value as Country })} class={`${input} w-28 px-2`}>
                {(Object.keys(COUNTRIES) as Country[]).map((c) => <option key={c} value={c}>{FLAGS[c]} +{COUNTRIES[c].prefix}</option>)}
              </select>
            </label>
            <label class="flex flex-1 flex-col gap-1 text-sm text-slate-600">{t('details.phone')}
              <input required type="tel" inputMode="tel" autoComplete="tel-national" value={form.phone} onInput={(e) => setForm({ ...form, phone: e.currentTarget.value })} class={input} />
            </label>
          </div>
          <div class="flex items-center justify-between text-sm text-slate-600">
            <span>{t('details.party')}</span>
            <div class="flex items-center gap-3">
              <button type="button" aria-label="−" onClick={() => setForm({ ...form, partySize: Math.max(1, form.partySize - 1) })} class="size-11 rounded-full border border-slate-300 bg-white text-xl">−</button>
              <span class="w-6 text-center text-xl font-semibold text-slate-900">{form.partySize}</span>
              <button type="button" aria-label="+" onClick={() => setForm({ ...form, partySize: Math.min(20, form.partySize + 1) })} class="size-11 rounded-full border border-slate-300 bg-white text-xl">+</button>
            </div>
          </div>
          {error && <p role="alert" class="rounded-lg bg-brand-50 px-3 py-2 text-brand-700">{error}</p>}
          <button disabled={busy} class="rounded-xl bg-brand-600 py-4 text-lg font-bold text-white disabled:opacity-40">{t('details.submit')}</button>
          <p class="text-center text-xs text-slate-500">{t('details.hold')}</p>
        </form>
      )}
      {error && step !== 5 && <p role="alert" class="rounded-lg bg-brand-50 px-3 py-2 text-brand-700">{error}</p>}
    </main>
  );
}
