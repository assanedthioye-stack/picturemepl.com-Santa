import { useEffect, useMemo, useState } from 'react';
import { COUNTRIES, PRINT_LABEL, type MomoMethod, type PrintSize } from '@pmp/shared';
import { api, useEvents, type Me, type PhotoDto } from '../api';
import { errorText, money, useT } from '../i18n';
import { TopBar } from './StaffApp';

interface Family { bookingId: string; bookingCode: string; familyName: string | null; photoCount: number; favCount: number }
interface Package { id: string; code: string; nameFr: string; nameEn: string; priceXof: number; digitalsIncluded: number; prints: Partial<Record<PrintSize, number>> }
interface Drawer { id: string; openingFloatXof: number }
type Method = 'cash' | MomoMethod;

export function Cashier({ me, onSignOut, nav }: { me: Me; onSignOut(): void; nav?: React.ReactNode }) {
  const { t, locale } = useT();
  const [families, setFamilies] = useState<Family[]>([]);
  const [packages, setPackages] = useState<Package[]>([]);
  const [drawer, setDrawer] = useState<Drawer | null>(null);
  const [family, setFamily] = useState<Family | null>(null);
  const [photos, setPhotos] = useState<PhotoDto[]>([]);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [digital, setDigital] = useState<Set<string>>(new Set());
  const [slots, setSlots] = useState<Partial<Record<PrintSize, string[]>>>({});
  const [checkout, setCheckout] = useState<{ orderId: string; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadFamilies = () => api<Family[]>('GET', '/api/pos/families').then(setFamilies, () => {});
  const loadDrawer = () => api<Drawer | null>('GET', '/api/pos/drawer').then(setDrawer, () => {});
  useEffect(() => {
    void loadFamilies();
    void loadDrawer();
    api<Package[]>('GET', '/api/pos/packages').then(setPackages, () => {});
  }, []);
  useEvents({
    'session.updated': () => void loadFamilies(),
    'order.paid': () => void loadFamilies(),
    'photo.updated': (p: PhotoDto) => setPhotos((ps) => ps.map((x) => (x.id === p.id ? p : x))), // ♥ from the family screen
  });

  async function open(f: Family) {
    setFamily(f);
    setQty({});
    setSlots({});
    setError(null);
    const ps = await api<PhotoDto[]>('GET', `/api/pos/families/${f.bookingId}/photos`);
    setPhotos(ps);
    const favs = ps.filter((p) => p.favorite);
    setDigital(new Set((favs.length ? favs : ps).map((p) => p.id)));
    void api('POST', `/api/pos/families/${f.bookingId}/show`).catch(() => {}); // family sees their photos on the 2nd screen
  }

  // What the chosen packages include.
  const { total, digitalsAllowed, printsNeeded } = useMemo(() => {
    let total = 0, digitals = 0;
    const prints: Partial<Record<PrintSize, number>> = {};
    for (const p of packages) {
      const n = qty[p.id] ?? 0;
      if (!n) continue;
      total += p.priceXof * n;
      digitals = digitals === -1 || p.digitalsIncluded === -1 ? -1 : digitals + p.digitalsIncluded * n;
      for (const [s, c] of Object.entries(p.prints) as [PrintSize, number][]) prints[s] = (prints[s] ?? 0) + c * n;
    }
    return { total, digitalsAllowed: digitals, printsNeeded: prints };
  }, [packages, qty]);

  // Keep one slot per included print, pre-filled from the chosen photos.
  useEffect(() => {
    const pool = photos.filter((p) => digital.has(p.id)).concat(photos.filter((p) => !digital.has(p.id))).map((p) => p.id);
    setSlots((old) => {
      const next: Partial<Record<PrintSize, string[]>> = {};
      for (const [size, n] of Object.entries(printsNeeded) as [PrintSize, number][]) {
        const prev = old[size] ?? [];
        next[size] = Array.from({ length: n }, (_, i) => prev[i] ?? pool[i % Math.max(1, pool.length)]!).filter(Boolean);
      }
      return next;
    });
  }, [printsNeeded, photos, digital]);

  const digitalIds = digitalsAllowed === 0 ? [] : photos.filter((p) => digital.has(p.id)).map((p) => p.id);
  const digitalOk = digitalsAllowed === 0 || (digitalIds.length > 0 && (digitalsAllowed === -1 || digitalIds.length <= digitalsAllowed));
  const vat = Math.round((total * 1800) / 11800); // display only; the server computes the receipt

  async function charge() {
    if (!family) return;
    setError(null);
    try {
      const order = await api<{ id: string; totalXof: number }>('POST', '/api/pos/orders', {
        bookingId: family.bookingId,
        lines: packages.filter((p) => qty[p.id]).map((p) => ({ packageId: p.id, qty: qty[p.id] })),
        digitalPhotoIds: digitalIds,
        printSlots: (Object.entries(slots) as [PrintSize, string[]][]).flatMap(([size, ids]) => ids.map((photoId) => ({ size, photoId }))),
      });
      setCheckout({ orderId: order.id, total: order.totalXof });
    } catch (e) {
      setError(errorText(t, e));
    }
  }

  const seqOf = (id: string) => photos.find((p) => p.id === id)?.seq;
  const contents = (p: Package) => [
    ...(Object.entries(p.prints) as [PrintSize, number][]).map(([s, n]) =>
      s === 'wallet4' ? `${n * 4} ${t('pos.wallets')}` : `${n} × ${PRINT_LABEL[s]}`),
    ...(p.digitalsIncluded === -1 ? [t('pos.digital.all')] : p.digitalsIncluded > 0 ? [`${p.digitalsIncluded} ${t('pos.digital.one')}`] : []),
  ].join(' · ');

  return (
    <div className="flex h-full flex-col">
      <TopBar me={me} onSignOut={onSignOut}>
        {nav}
        <DrawerControl drawer={drawer} onChange={loadDrawer} />
      </TopBar>
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[17rem_1fr_22rem]">
        <aside className="overflow-y-auto border-r border-slate-200 bg-white p-3">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">{t('pos.families')}</h2>
          {families.length === 0 && <p className="text-slate-500">{t('pos.families.empty')}</p>}
          <ul className="flex flex-col gap-2">
            {families.map((f) => (
              <li key={f.bookingId}>
                <button onClick={() => open(f)} aria-pressed={family?.bookingId === f.bookingId}
                  className={`w-full rounded-xl border p-3 text-left ${family?.bookingId === f.bookingId ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:bg-slate-50'}`}>
                  <p className="font-semibold">{f.familyName ?? '—'}</p>
                  <p className="text-sm text-slate-500"><span className="font-mono">{f.bookingCode}</span> · {f.photoCount} {t('ph.photos')} · ♥ {f.favCount}</p>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <main className="min-h-0 overflow-y-auto p-4">
          {family && (
            <>
              <h2 className="text-lg font-semibold">{t('pos.photos')} <span className="text-slate-400">({digital.size}/{photos.length})</span></h2>
              <p className="mb-3 text-sm text-slate-500">{t('pos.photos.hint')}</p>
              <ul className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                {photos.map((p) => {
                  const on = digital.has(p.id);
                  return (
                    <li key={p.id}>
                      <button aria-pressed={on} onClick={() => setDigital((s) => { const n = new Set(s); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n; })}
                        className={`relative block w-full overflow-hidden rounded-xl ring-4 ${on ? 'ring-brand-500' : 'ring-transparent opacity-60'}`}>
                        <img src={p.previewUrl} alt={`#${p.seq}`} className="aspect-[3/2] w-full object-cover" />
                        <span className="absolute left-2 top-2 rounded bg-black/60 px-2 text-sm font-bold text-white">#{p.seq}</span>
                        {p.favorite && <span className="absolute right-2 top-1 text-2xl text-brand-500 drop-shadow">♥</span>}
                        {on && <span className="absolute bottom-2 right-2 grid size-7 place-items-center rounded-full bg-brand-600 font-bold text-white">✓</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </main>

        <aside className="flex min-h-0 flex-col border-l border-slate-200 bg-white">
          {family && (
            <>
              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
              <section>
                <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">{t('pos.packages')}</h2>
                <ul className="flex flex-col gap-2">
                  {packages.map((p) => (
                    <li key={p.id} className="flex items-center gap-2 rounded-xl border border-slate-200 p-2">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium leading-tight">{locale === 'fr' ? p.nameFr : p.nameEn} <span className="font-normal text-slate-500">· {money(locale, p.priceXof)}</span></p>
                        <p className="text-xs leading-snug text-slate-500">{contents(p)}</p>
                      </div>
                      <button aria-label="−" onClick={() => setQty({ ...qty, [p.id]: Math.max(0, (qty[p.id] ?? 0) - 1) })} className="size-9 rounded-full border border-slate-300">−</button>
                      <span className="w-5 text-center font-semibold">{qty[p.id] ?? 0}</span>
                      <button aria-label="+" onClick={() => setQty({ ...qty, [p.id]: (qty[p.id] ?? 0) + 1 })} className="size-9 rounded-full bg-slate-900 text-white">+</button>
                    </li>
                  ))}
                </ul>
              </section>

              {Object.keys(slots).length > 0 && (
                <section>
                  <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">{t('pos.slots')}</h2>
                  {(Object.entries(slots) as [PrintSize, string[]][]).map(([size, ids]) => (
                    <div key={size} className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="w-16 font-semibold">{PRINT_LABEL[size]}</span>
                      {ids.map((id, i) => (
                        <select key={i} aria-label={`${size} ${i + 1}`} value={id}
                          onChange={(e) => setSlots({ ...slots, [size]: ids.map((x, j) => (j === i ? e.target.value : x)) })}
                          className="rounded-lg border border-slate-300 px-2 py-1">
                          {photos.map((p) => <option key={p.id} value={p.id}>#{p.seq}</option>)}
                        </select>
                      ))}
                    </div>
                  ))}
                </section>
              )}

              </div>

              {/* Fixed footer: the total and the charge button never scroll away. */}
              <section className="border-t border-slate-200 px-4 pb-4 pt-3 shadow-[0_-8px_16px_-12px_rgba(0,0,0,0.25)]">
                <div className="flex items-baseline justify-between">
                  <span className="text-slate-500">{t('pos.total')}</span>
                  <span className="text-3xl font-bold">{money(locale, total)}</span>
                </div>
                <p className="text-right text-sm text-slate-500">{t('pos.vat')} {money(locale, vat)}</p>
                {digitalsAllowed > 0 && (
                  <p className={`text-sm ${digitalIds.length > digitalsAllowed ? 'font-semibold text-brand-600' : 'text-slate-500'}`}>
                    {digitalIds.length}/{digitalsAllowed} {t('pos.digital.one')}{digitalIds.length > digitalsAllowed && ` — ${t('pos.digital.over')}`}
                  </p>
                )}
                {error && <p role="alert" className="mt-2 rounded-lg bg-brand-50 px-3 py-2 text-brand-700">{error}</p>}
                <button onClick={charge} disabled={total === 0 || !digitalOk || Object.values(slots).some((s) => s.length === 0)}
                  className="mt-3 w-full rounded-xl bg-brand-600 py-4 text-lg font-bold text-white disabled:opacity-30">
                  {t('pos.charge')} {total > 0 && money(locale, total)}
                </button>
                {Object.entries(slots).length > 0 && (
                  <p className="mt-2 text-xs text-slate-400">
                    {(Object.entries(slots) as [PrintSize, string[]][]).map(([s, ids]) => `${PRINT_LABEL[s]}: ${ids.map((id) => `#${seqOf(id)}`).join(' ')}`).join(' · ')}
                  </p>
                )}
              </section>
            </>
          )}
        </aside>
      </div>

      {checkout && (
        <PaymentModal total={checkout.total} orderId={checkout.orderId} drawerOpen={!!drawer} methods={['cash', ...COUNTRIES[me.boothCountry].momo]}
          onClose={() => setCheckout(null)}
          onPaid={() => { setCheckout(null); setFamily(null); setPhotos([]); void loadFamilies(); }} />
      )}
    </div>
  );
}

function PaymentModal({ total, orderId, drawerOpen, methods, onClose, onPaid }: { total: number; orderId: string; drawerOpen: boolean; methods: Method[]; onClose(): void; onPaid(): void }) {
  const { t, locale } = useT();
  const [method, setMethod] = useState<Method>('cash');
  const [tendered, setTendered] = useState(total);
  const [reference, setReference] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ change: number } | null>(null);
  const rounds = [...new Set([total, Math.ceil(total / 5000) * 5000, Math.ceil(total / 10000) * 10000, Math.ceil(total / 10000) * 10000 + 10000])];

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const body = method === 'cash' ? { method, tenderedXof: tendered } : { method, reference, payerPhone: phone || undefined };
      const r = await api<{ changeXof: number }>('POST', `/api/pos/orders/${orderId}/pay`, body);
      setDone({ change: r.changeXof });
    } catch (e) {
      setError(errorText(t, e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-10 grid place-items-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="pay-title">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl">
        {done ? (
          <div className="flex flex-col items-center gap-3 text-center">
            <p className="grid size-16 place-items-center rounded-full bg-emerald-100 text-3xl text-emerald-700">✓</p>
            <h2 id="pay-title" className="text-xl font-bold">{t('pay.done')}</h2>
            {done.change > 0 && <p className="text-lg">{t('pay.change')} : <b className="text-2xl">{money(locale, done.change)}</b></p>}
            <p className="text-sm text-slate-500">{t('pay.done.sub')}</p>
            <button autoFocus onClick={onPaid} className="mt-2 w-full rounded-xl bg-slate-900 py-3 font-semibold text-white">{t('pay.next')}</button>
          </div>
        ) : (
          <>
            <div className="mb-4 flex items-baseline justify-between">
              <h2 id="pay-title" className="text-xl font-bold">{t('pay.title')}</h2>
              <span className="text-2xl font-bold">{money(locale, total)}</span>
            </div>
            <div className="mb-4 grid gap-1 rounded-xl bg-slate-100 p-1" style={{ gridTemplateColumns: `repeat(${methods.length}, 1fr)` }} role="tablist">
              {methods.map((m) => (
                <button key={m} role="tab" aria-selected={method === m} onClick={() => { setMethod(m); setError(null); }}
                  className={`rounded-lg px-1 py-2 text-sm font-semibold ${method === m ? 'bg-white shadow' : 'text-slate-600'}`}>{t(`pay.${m}`)}</button>
              ))}
            </div>
            {method === 'cash' ? (
              <div className="flex flex-col gap-3">
                {!drawerOpen && <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-amber-800">{t('err.drawer_closed')}</p>}
                <label className="flex flex-col gap-1 text-sm text-slate-600">{t('pay.tendered')}
                  <input type="number" inputMode="numeric" min={0} step={500} value={tendered} onChange={(e) => setTendered(Number(e.target.value))}
                    className="rounded-xl border border-slate-300 px-4 py-3 text-2xl font-semibold" />
                </label>
                <div className="flex flex-wrap gap-2">
                  {rounds.map((v) => (
                    <button key={v} onClick={() => setTendered(v)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
                      {v === total ? t('pay.exact') : money(locale, v)}
                    </button>
                  ))}
                </div>
                <p className="flex justify-between text-lg">{t('pay.change')} <b>{money(locale, Math.max(0, tendered - total))}</b></p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">{t('pay.momo.hint')}</p>
                <label className="flex flex-col gap-1 text-sm text-slate-600">{t('pay.reference')}
                  <input value={reference} onChange={(e) => setReference(e.target.value.trim())} autoComplete="off"
                    className="rounded-xl border border-slate-300 px-4 py-3 font-mono text-lg" />
                </label>
                <label className="flex flex-col gap-1 text-sm text-slate-600">{t('pay.phone')}
                  <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className="rounded-xl border border-slate-300 px-4 py-3" />
                </label>
              </div>
            )}
            {error && <p role="alert" className="mt-3 rounded-lg bg-brand-50 px-3 py-2 text-brand-700">{error}</p>}
            <div className="mt-5 flex gap-2">
              <button onClick={onClose} className="flex-1 rounded-xl border border-slate-300 py-3 font-medium">{t('cancel')}</button>
              <button onClick={pay} disabled={busy || (method === 'cash' ? tendered < total || !drawerOpen : reference.length < 4)}
                className="flex-[2] rounded-xl bg-brand-600 py-3 font-bold text-white disabled:opacity-30">{t('pay.confirm')}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function DrawerControl({ drawer, onChange }: { drawer: Drawer | null; onChange(): void }) {
  const { t, locale } = useT();
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(0);
  const [result, setResult] = useState<{ expectedXof: number; varianceXof: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (drawer) setResult(await api('POST', '/api/pos/drawer/close', { countedXof: amount }));
      else await api('POST', '/api/pos/drawer/open', { openingFloatXof: amount });
      setEditing(false);
      setAmount(0);
      onChange();
    } catch (err) {
      setError(errorText(t, err));
    }
  }

  if (result) {
    return (
      <button onClick={() => setResult(null)} className={`rounded-full px-3 py-1.5 text-sm font-medium ${result.varianceXof === 0 ? 'bg-emerald-50 text-emerald-800' : 'bg-brand-50 text-brand-700'}`}>
        {t('pos.drawer.result')} {money(locale, result.expectedXof)} · {t('pos.drawer.variance')} {money(locale, result.varianceXof)} ✕
      </button>
    );
  }
  if (editing) {
    return (
      <form onSubmit={submit} className="flex items-center gap-2">
        <label className="sr-only" htmlFor="drawer-amt">{drawer ? t('pos.drawer.count') : t('pos.drawer.float')}</label>
        <input id="drawer-amt" autoFocus type="number" min={0} step={500} placeholder={drawer ? t('pos.drawer.count') : t('pos.drawer.float')}
          value={amount || ''} onChange={(e) => setAmount(Number(e.target.value))} className="w-44 rounded-lg border border-slate-300 px-3 py-1.5" />
        <button className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white">OK</button>
        <button type="button" onClick={() => setEditing(false)} className="text-sm text-slate-500">{t('cancel')}</button>
        {error && <span role="alert" className="text-sm text-brand-600">{error}</span>}
      </form>
    );
  }
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 ${drawer ? 'border-emerald-300' : 'border-amber-300 bg-amber-50'}`}>
        <span className={`size-2.5 rounded-full ${drawer ? 'bg-emerald-500' : 'bg-amber-500'}`} aria-hidden />
        {drawer ? t('pos.drawer.isopen') : t('pos.drawer.closed')}
      </span>
      <button onClick={() => setEditing(true)} className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium">
        {drawer ? t('pos.drawer.close') : t('pos.drawer.open')}
      </button>
    </div>
  );
}
