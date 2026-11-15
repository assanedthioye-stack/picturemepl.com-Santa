import { QRCodeCanvas } from 'qrcode.react';
import { useEffect, useRef, useState } from 'preact/hooks';
import { COUNTRIES, type Country } from '@pmp/shared/src/phone';
import { PRICE_LIST } from '@pmp/shared/src/prices';
import { api, store, TIME_ZONES } from './api';
import { money, useT, type Locale } from './i18n';

interface BookingView {
  status: string; code: string | null; familyName: string | null; partySize: number; venue: string; city: string; country: Country;
  startsAt: number | null; packageId: string | null; amountXof: number | null; paymentStatus: string | null; photoCount: number; photoPriceXof: number;
}
type Momo = 'wave' | 'orange_money' | 'mtn_momo';
// Celtiis Cash has no API integration yet: paid at the booth only.
const onlineMethods = (c: Country) => (COUNTRIES[c].momo as readonly string[]).filter((m) => m !== 'celtiis_cash') as Momo[];

export function Booking({ token }: { token: string }) {
  const { t, err, locale } = useT();
  const [b, setB] = useState<BookingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(new URLSearchParams(location.search).has('paid'));

  const load = () => api<BookingView>('GET', `/api/bookings/${token}`).then((v) => {
    setB(v);
    setError(null);
    if (v.paymentStatus !== 'pending') setWaiting(false); // settled while the page loaded
    return v;
  }, (e) => { setError(err(e)); return null; });
  useEffect(() => { void load(); }, [token]);
  // Poll while a payment is being confirmed (webhook or not, the server re-asks the provider).
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(async () => {
      const v = await load();
      if (v && v.paymentStatus !== 'pending') setWaiting(false);
    }, 3000);
    return () => clearInterval(id);
  }, [waiting]);

  if (!b) return <main class="mx-auto max-w-md p-4">{error ? <p role="alert" class="text-brand-700">{error}</p> : <p role="status">…</p>}</main>;
  const pkg = PRICE_LIST.find((p) => b.packageId === `pkg_${p.code}_${b.country}`);
  const when = b.startsAt ? new Intl.DateTimeFormat(locale === 'fr' ? 'fr-FR' : 'en-GB', {
    timeZone: TIME_ZONES[b.country], weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  }).format(b.startsAt) : '';

  return (
    <main class="mx-auto flex max-w-md flex-col gap-4 px-4 pb-10 pt-4">
      {b.status === 'pending_payment' ? (
        <Pay token={token} b={b} pkgName={pkg ? (locale === 'fr' ? pkg.nameFr : pkg.nameEn) : ''} when={when}
          waiting={waiting} onStarted={() => setWaiting(true)} />
      ) : (
        <Ticket token={token} b={b} when={when} pkgName={pkg ? (locale === 'fr' ? pkg.nameFr : pkg.nameEn) : ''} />
      )}
      {b.photoCount > 0 && <Gallery token={token} country={b.country} onPaying={() => setWaiting(true)} waiting={waiting} />}
      {error && <p role="alert" class="rounded-lg bg-brand-50 px-3 py-2 text-brand-700">{error}</p>}
    </main>
  );
}

function PayForm({ country, amount, onPay, busy }: { country: Country; amount: number; busy: boolean; onPay(method: Momo, phone?: string): void }) {
  const { t, locale } = useT();
  const methods = onlineMethods(country);
  const [method, setMethod] = useState<Momo>(methods[0]!);
  const [phone, setPhone] = useState('');
  return (
    <div class="flex flex-col gap-3">
      <p class="text-sm font-medium text-slate-600">{t('pay.with')}</p>
      <div class="grid grid-cols-2 gap-2" role="radiogroup">
        {methods.map((m) => (
          <button key={m} role="radio" aria-checked={m === method} onClick={() => setMethod(m)}
            class={`rounded-xl border-2 bg-white py-3 font-semibold ${m === method ? 'border-brand-600' : 'border-slate-200'}`}>{t(`pay.${m}`)}</button>
        ))}
      </div>
      {method === 'mtn_momo' && (
        <label class="flex flex-col gap-1 text-sm text-slate-600">{t('pay.phone')} (+{COUNTRIES[country].prefix})
          <input type="tel" inputMode="tel" autoComplete="tel-national" value={phone} onInput={(e) => setPhone(e.currentTarget.value)}
            class="rounded-xl border border-slate-300 bg-white px-4 py-3 text-lg" />
        </label>
      )}
      <button disabled={busy || (method === 'mtn_momo' && phone.length < 8)} onClick={() => onPay(method, phone || undefined)}
        class="rounded-xl bg-brand-600 py-4 text-lg font-bold text-white disabled:opacity-40">{t('pay.go')} {money(locale, amount)}</button>
    </div>
  );
}

/** Redirect flows leave for the provider's page; MTN pushes a prompt to the phone and we poll. */
async function startPayment(path: string, body: object, session?: string): Promise<'push'> {
  const r = await api<{ kind: 'redirect' | 'push'; url?: string }>('POST', path, body, session);
  if (r.kind === 'redirect' && r.url) { location.href = r.url; await new Promise(() => {}); }
  return 'push';
}

function Pay({ token, b, pkgName, when, waiting, onStarted }: { token: string; b: BookingView; pkgName: string; when: string; waiting: boolean; onStarted(): void }) {
  const { t, err, locale } = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pay = async (method: Momo, phone?: string) => {
    setBusy(true);
    setError(null);
    try { await startPayment(`/api/bookings/${token}/pay`, { method, phone, phoneCountry: b.country }); onStarted(); } catch (e) { setError(err(e)); } finally { setBusy(false); }
  };
  return (
    <section class="flex flex-col gap-4">
      <h1 class="text-2xl font-bold">{t('pay.title')}</h1>
      <div class="rounded-2xl bg-white p-4 shadow-sm">
        <p class="font-semibold">{b.familyName}</p>
        <p class="text-slate-600">{b.venue}, {b.city}</p>
        <p class="text-slate-600 first-letter:uppercase">{when}</p>
        <p class="mt-2 flex justify-between"><span>{pkgName}</span><b>{money(locale, b.amountXof ?? 0)}</b></p>
      </div>
      {waiting ? (
        <p role="status" class="animate-pulse rounded-xl bg-white p-4 text-center font-medium shadow-sm">{t('pay.waiting')}<br /><span class="text-sm font-normal text-slate-500">{t('pay.push')}</span></p>
      ) : (
        <>
          {b.paymentStatus === 'failed' && <p role="alert" class="rounded-lg bg-brand-50 px-3 py-2 text-brand-700">{t('pay.failed')}</p>}
          <PayForm country={b.country} amount={b.amountXof ?? 0} busy={busy} onPay={pay} />
        </>
      )}
      {error && <p role="alert" class="rounded-lg bg-brand-50 px-3 py-2 text-brand-700">{error}</p>}
    </section>
  );
}

function Ticket({ token, b, when, pkgName }: { token: string; b: BookingView; when: string; pkgName: string }) {
  const { t } = useT();
  const qr = useRef<HTMLCanvasElement>(null);
  const pin = store.get(`pmp.pin.${token}`);
  // The link opens this page from any phone; code= lets the booth's scanner read the code reliably.
  const link = `${location.origin}/b/${token}?code=${b.code}`;
  const share = `https://wa.me/?text=${encodeURIComponent(
    `📸 Picture Me Please — ${t('ticket.confirmed')}\n${t('ticket.code')} : ${b.code}\n${b.venue}, ${b.city}\n${when}\n${link}`)}`;

  const download = () => {
    const c = document.createElement('canvas');
    c.width = 720; c.height = 1080;
    const g = c.getContext('2d')!;
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#be123c'; g.fillRect(0, 0, c.width, 120);
    g.fillStyle = '#ffffff'; g.font = 'bold 44px system-ui, sans-serif'; g.textAlign = 'center';
    g.fillText('Picture Me Please', 360, 78);
    g.drawImage(qr.current!, 160, 160, 400, 400);
    g.fillStyle = '#0f172a'; g.font = 'bold 30px system-ui, sans-serif';
    g.fillText(t('ticket.code'), 360, 620);
    g.font = 'bold 96px ui-monospace, monospace'; g.fillText(b.code ?? '', 360, 720);
    g.font = '30px system-ui, sans-serif'; g.fillStyle = '#334155';
    g.fillText(b.familyName ?? '', 360, 790);
    g.fillText(`${b.venue}, ${b.city}`, 360, 840);
    g.fillText(when, 360, 890);
    if (pin) { g.fillStyle = '#be123c'; g.font = 'bold 30px system-ui, sans-serif'; g.fillText(`${t('ticket.pin')} : ${pin}`, 360, 970); }
    c.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob!);
      a.download = `billet-picture-me-please-${b.code}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }, 'image/png');
  };

  return (
    <section class="flex flex-col items-center gap-4 rounded-3xl bg-white p-5 text-center shadow-sm">
      <p class="rounded-full bg-emerald-50 px-3 py-1 text-sm font-semibold text-emerald-700">✓ {t('ticket.confirmed')}</p>
      {/* Black on white, high error correction: readable on a cracked screen under mall lighting. */}
      <QRCodeCanvas ref={qr} value={link} size={240} level="H" marginSize={4} bgColor="#ffffff" fgColor="#000000"
        aria-label={`${t('ticket.code')} ${b.code}`} role="img" />
      <div>
        <p class="text-sm text-slate-500">{t('ticket.code')}</p>
        <p class="font-mono text-5xl font-bold tracking-widest">{b.code}</p>
      </div>
      <p class="text-sm text-slate-500">{t('ticket.show')}</p>
      <div class="w-full rounded-xl bg-slate-50 p-3 text-left">
        <p class="font-semibold">{b.familyName} · {b.partySize} {t('ticket.people')}</p>
        <p class="text-slate-600">{b.venue}, {b.city}</p>
        <p class="text-slate-600 first-letter:uppercase">{when}</p>
        {pkgName && <p class="text-slate-600">{pkgName}</p>}
      </div>
      {pin && (
        <div class="w-full rounded-xl border-2 border-dashed border-brand-600 p-3">
          <p class="text-sm text-slate-600">{t('ticket.pin')}</p>
          <p class="font-mono text-3xl font-bold tracking-[0.3em] text-brand-700">{pin}</p>
          <p class="text-xs text-slate-500">{t('ticket.pin.keep')}</p>
        </div>
      )}
      <div class="grid w-full grid-cols-2 gap-2">
        <button onClick={download} class="rounded-xl border border-slate-300 py-3 font-semibold">⬇ {t('ticket.download')}</button>
        <a href={share} target="_blank" rel="noopener" class="rounded-xl bg-[#1fa855] py-3 font-semibold text-white">{t('ticket.share')}</a>
      </div>
    </section>
  );
}

interface GPhoto { id: string; seq: number; thumbUrl: string; previewUrl: string; unlocked: boolean; downloadUrl: string | null }

function Gallery({ token, country, waiting, onPaying }: { token: string; country: Country; waiting: boolean; onPaying(): void }) {
  const { t, err, locale } = useT();
  const key = `pmp.g.${token}`;
  const [session, setSession] = useState<string | null>(() => { try { return sessionStorage.getItem(key); } catch { return null; } });
  const [pin, setPin] = useState('');
  const [data, setData] = useState<{ unitPriceXof: number; photos: GPhoto[] } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<GPhoto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = (s: string) => api<{ unitPriceXof: number; photos: GPhoto[] }>('GET', `/api/gallery/${token}/photos`, undefined, s)
    .then(setData, (e) => { if ((e as Error).message === 'gallery_login_required') setSession(null); });
  useEffect(() => { if (session) void load(session); }, [session, waiting]); // reload once a purchase settles

  async function login(e: Event) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api<{ session: string }>('POST', `/api/gallery/${token}/login`, { pin });
      try { sessionStorage.setItem(key, r.session); } catch { /* private mode */ }
      setSession(r.session);
    } catch (ex) {
      setError((ex as Error).message === 'too_many_attempts' ? t('gallery.locked') : (ex as Error).message === 'wrong_pin' ? t('gallery.wrong') : err(ex));
      setPin('');
    }
  }

  const buy = async (method: Momo, phone?: string) => {
    setBusy(true);
    setError(null);
    try {
      await startPayment(`/api/gallery/${token}/buy`, { photoIds: [...picked], method, phone, phoneCountry: country }, session!);
      setPicked(new Set());
      onPaying();
    } catch (e) { setError(err(e)); } finally { setBusy(false); }
  };

  const shareFile = async (p: GPhoto) => {
    try {
      const blob = await (await fetch(p.downloadUrl!)).blob();
      const file = new File([blob], `picture-me-please-${p.seq}.jpg`, { type: 'image/jpeg' });
      if (navigator.canShare?.({ files: [file] })) return await navigator.share({ files: [file], title: 'Picture Me Please' });
    } catch { /* fall back to a link */ }
    window.open(`https://wa.me/?text=${encodeURIComponent(`📸 Picture Me Please\n${location.origin}/b/${token}`)}`, '_blank', 'noopener');
  };

  if (!session) {
    return (
      <section class="flex flex-col gap-3 rounded-2xl bg-white p-4 shadow-sm">
        <h2 class="text-xl font-bold">{t('gallery.title')}</h2>
        <form onSubmit={login} class="flex flex-col gap-3">
          <label class="flex flex-col gap-1 text-sm text-slate-600">{t('gallery.pin')}
            <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={pin} onInput={(e) => setPin(e.currentTarget.value.replace(/\D/g, ''))}
              class="rounded-xl border border-slate-300 px-4 py-3 text-center font-mono text-3xl tracking-[0.4em]" />
          </label>
          <button disabled={pin.length !== 6} class="rounded-xl bg-slate-900 py-3 font-bold text-white disabled:opacity-40">{t('gallery.open')}</button>
        </form>
        {error && <p role="alert" class="rounded-lg bg-brand-50 px-3 py-2 text-brand-700">{error}</p>}
      </section>
    );
  }

  const total = (data?.unitPriceXof ?? 0) * picked.size;
  return (
    <section class="flex flex-col gap-3">
      <h2 class="text-xl font-bold">{t('gallery.title')}</h2>
      <p class="text-sm text-slate-500">{t('gallery.hint')}</p>
      <ul class="grid grid-cols-2 gap-2">
        {data?.photos.map((p) => (
          <li key={p.id} class="relative">
            <button onClick={() => setOpen(p)} class="block w-full overflow-hidden rounded-xl bg-slate-200" aria-label={`Photo ${p.seq}`}>
              <img src={p.thumbUrl} alt="" loading="lazy" width={400} height={267} class="aspect-[3/2] w-full object-cover" />
            </button>
            <span class={`pointer-events-none absolute right-2 top-2 rounded-full px-2 py-0.5 text-xs font-bold ${p.unlocked ? 'bg-emerald-600 text-white' : picked.has(p.id) ? 'bg-brand-600 text-white' : 'bg-black/60 text-white'}`}>
              {p.unlocked ? 'HD ✓' : picked.has(p.id) ? '✓' : '🔒'}
            </span>
          </li>
        ))}
      </ul>

      {picked.size > 0 && !waiting && (
        <div class="sticky bottom-2 flex flex-col gap-3 rounded-2xl bg-white p-4 shadow-lg">
          <p class="font-semibold">{t('gallery.unlock')} {picked.size} {t('gallery.photos')} — {money(locale as Locale, total)}</p>
          <PayForm country={country} amount={total} busy={busy} onPay={buy} />
        </div>
      )}
      {waiting && <p role="status" class="animate-pulse rounded-xl bg-white p-4 text-center font-medium shadow-sm">{t('pay.waiting')}</p>}
      {error && <p role="alert" class="rounded-lg bg-brand-50 px-3 py-2 text-brand-700">{error}</p>}

      {open && (
        <div class="fixed inset-0 z-10 flex flex-col bg-black/95 p-3" role="dialog" aria-modal="true" aria-label={`Photo ${open.seq}`}>
          <button onClick={() => setOpen(null)} class="self-end rounded-lg bg-white/15 px-4 py-2 font-semibold text-white">{t('gallery.close')}</button>
          <img src={open.previewUrl} alt={`Photo ${open.seq}`} class="my-3 min-h-0 flex-1 object-contain" />
          {open.unlocked ? (
            open.downloadUrl ? (
              <div class="grid grid-cols-2 gap-2">
                <a href={open.downloadUrl} download={`picture-me-please-${open.seq}.jpg`} target="_blank" rel="noopener" class="rounded-xl bg-white py-3 text-center font-bold">⬇ {t('gallery.download')}</a>
                <button onClick={() => shareFile(open)} class="rounded-xl bg-[#1fa855] py-3 font-bold text-white">{t('gallery.share')}</button>
              </div>
            ) : <p class="text-center text-white/80">{t('gallery.preparing')}</p>
          ) : (
            <button onClick={() => { setPicked((s) => { const n = new Set(s); if (n.has(open.id)) n.delete(open.id); else n.add(open.id); return n; }); setOpen(null); }}
              class="rounded-xl bg-brand-600 py-3 font-bold text-white">
              {picked.has(open.id) ? t('gallery.selected') : `${t('gallery.select')} · ${money(locale as Locale, data?.unitPriceXof ?? 0)}`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
