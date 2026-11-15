import { useCallback, useEffect, useState } from 'react';
import { COUNTRIES, type Country } from '@pmp/shared';
import { api, useEvents, type Me } from '../api';
import { errorText, useT } from '../i18n';
import { QrScanner } from './QrScanner';
import { TopBar } from './StaffApp';

interface QueueRow {
  id: string; lane: 'booked' | 'walk_in'; status: 'waiting' | 'called' | 'shooting';
  bookingCode: string; name: string | null; partySize: number; enqueuedAt: number;
}

export function Host({ me, onSignOut, nav }: { me: Me; onSignOut(): void; nav?: React.ReactNode }) {
  const { t, locale } = useT();
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [scanning, setScanning] = useState(false);
  const [code, setCode] = useState('');
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);
  const [walkIn, setWalkIn] = useState({ fullName: '', phone: '', country: me.boothCountry as Country, partySize: 2 });
  const [added, setAdded] = useState<{ bookingCode: string; pin: string } | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => { api<QueueRow[]>('GET', '/api/queue').then(setQueue, () => {}); }, []);
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(i); }, []);
  useEvents({ 'queue.updated': setQueue });

  const checkIn = useCallback(async (raw: string) => {
    setScanning(false);
    try {
      const r = await api<{ alreadyCheckedIn: boolean }>('POST', '/api/queue/check-in', { code: raw });
      setFlash({ ok: true, text: r.alreadyCheckedIn ? t('host.checkin.already') : t('host.checkin.ok') });
      setCode('');
    } catch (e) {
      setFlash({ ok: false, text: errorText(t, e) });
    }
  }, [t]);

  const addWalkIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setFlash(null);
    try {
      setAdded(await api('POST', '/api/queue/walk-in', walkIn));
      setWalkIn((w) => ({ ...w, fullName: '', phone: '', partySize: 2 }));
    } catch (err) {
      setFlash({ ok: false, text: errorText(t, err) });
    }
  };

  const act = (url: string) => api('POST', url).catch((e) => setFlash({ ok: false, text: errorText(t, e) }));
  const input = 'w-full rounded-xl border border-slate-300 px-4 py-3 text-lg focus:border-brand-500 focus:outline-none';
  const prefix = `+${COUNTRIES[walkIn.country].prefix}`;

  return (
    <div className="flex h-full flex-col">
      <TopBar me={me} onSignOut={onSignOut}>{nav}</TopBar>
      <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-4 lg:grid-cols-[minmax(20rem,28rem)_1fr]">
        <div className="flex flex-col gap-4">
          <section className="rounded-2xl border border-slate-200 bg-white p-4">
            {scanning ? (
              <QrScanner onCode={checkIn} onClose={() => setScanning(false)} />
            ) : (
              <button onClick={() => { setFlash(null); setScanning(true); }}
                className="w-full rounded-xl bg-brand-600 py-4 text-lg font-bold text-white hover:bg-brand-700">▣ {t('host.scan')}</button>
            )}
            <label className="mt-4 block text-sm text-slate-600" htmlFor="code">{t('host.code')}</label>
            <form className="mt-1 flex gap-2" onSubmit={(e) => { e.preventDefault(); void checkIn(code); }}>
              <input id="code" inputMode="numeric" autoComplete="off" placeholder="••••••" value={code} maxLength={6}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                className={`${input} min-w-0 font-mono text-2xl tracking-[0.3em]`} />
              <button disabled={code.length !== 6} className="shrink-0 rounded-xl bg-slate-900 px-4 font-semibold text-white disabled:opacity-30">
                {t('host.checkin')}
              </button>
            </form>
            {flash && <p role="status" className={`mt-3 rounded-lg px-3 py-2 font-medium ${flash.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-brand-50 text-brand-700'}`}>{flash.text}</p>}
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-4">
            <h2 className="mb-3 text-lg font-semibold">{t('host.walkin.title')}</h2>
            {added ? (
              <div className="flex flex-col items-center gap-2 text-center">
                <p className="font-semibold text-emerald-700">✓ {t('host.walkin.done')}</p>
                <p className="font-mono text-3xl font-bold tracking-widest">{added.bookingCode}</p>
                <p className="mt-2 text-sm text-slate-600">{t('host.walkin.pin')}</p>
                <p className="font-mono text-4xl font-bold tracking-[0.3em] text-brand-600">{added.pin}</p>
                <button onClick={() => setAdded(null)} className="mt-3 rounded-lg border border-slate-300 px-4 py-2">OK</button>
              </div>
            ) : (
              <form className="flex flex-col gap-3" onSubmit={addWalkIn}>
                <label className="flex flex-col gap-1 text-sm text-slate-600">{t('host.walkin.name')}
                  <input required minLength={2} value={walkIn.fullName} onChange={(e) => setWalkIn({ ...walkIn, fullName: e.target.value })} className={input} autoComplete="off" />
                </label>
                <label className="flex flex-col gap-1 text-sm text-slate-600">{t('host.walkin.country')}
                  <select value={walkIn.country} onChange={(e) => setWalkIn({ ...walkIn, country: e.target.value as Country })} className={input}>
                    {(Object.keys(COUNTRIES) as Country[]).map((c) => (
                      <option key={c} value={c}>{locale === 'fr' ? COUNTRIES[c].nameFr : COUNTRIES[c].nameEn} (+{COUNTRIES[c].prefix})</option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm text-slate-600">{t('host.walkin.phone')}
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-lg text-slate-500">{prefix}</span>
                    <input required type="tel" inputMode="tel" value={walkIn.phone} onChange={(e) => setWalkIn({ ...walkIn, phone: e.target.value })} className={input} autoComplete="off" />
                  </div>
                </label>
                <div className="flex items-center justify-between text-sm text-slate-600">
                  <span>{t('host.walkin.party')}</span>
                  <div className="flex items-center gap-3">
                    <button type="button" aria-label="−" onClick={() => setWalkIn({ ...walkIn, partySize: Math.max(1, walkIn.partySize - 1) })} className="size-11 rounded-full border border-slate-300 text-xl">−</button>
                    <span className="w-6 text-center text-xl font-semibold text-slate-900">{walkIn.partySize}</span>
                    <button type="button" aria-label="+" onClick={() => setWalkIn({ ...walkIn, partySize: Math.min(20, walkIn.partySize + 1) })} className="size-11 rounded-full border border-slate-300 text-xl">+</button>
                  </div>
                </div>
                <button className="rounded-xl bg-slate-900 py-3 font-semibold text-white">{t('host.walkin.submit')}</button>
              </form>
            )}
          </section>
        </div>

        <section className="rounded-2xl border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-lg font-semibold">{t('host.queue')} <span className="text-slate-400">({queue.length})</span></h2>
          {queue.length === 0 && <p className="text-slate-500">{t('host.queue.empty')}</p>}
          <ol className="flex flex-col gap-2">
            {queue.map((q, i) => (
              <li key={q.id} className={`flex flex-wrap items-center gap-3 rounded-xl border p-3 ${q.status === 'waiting' ? 'border-slate-200' : 'border-emerald-300 bg-emerald-50'}`}>
                <span className="w-6 text-center text-lg font-bold text-slate-400">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-lg font-semibold">{q.name ?? '—'}</p>
                  <p className="text-sm text-slate-500">
                    <span className={`mr-2 rounded px-1.5 py-0.5 text-xs font-semibold ${q.lane === 'booked' ? 'bg-gold-400/30 text-amber-900' : 'bg-slate-100 text-slate-600'}`}>
                      {t(`host.lane.${q.lane}`)}
                    </span>
                    <span className="font-mono">{q.bookingCode}</span> · {q.partySize} {t('sessions.party')} · <span className="whitespace-nowrap">{Math.round((now - q.enqueuedAt) / 60_000)} min {t('host.wait')}</span>
                  </p>
                </div>
                {q.status === 'waiting' ? (
                  <div className="flex gap-2">
                    <button onClick={() => act(`/api/queue/${q.id}/left`)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">{t('host.left')}</button>
                    <button onClick={() => act(`/api/queue/${q.id}/send`)} className="rounded-lg bg-brand-600 px-4 py-2 font-semibold text-white">{t('host.send')} →</button>
                  </div>
                ) : (
                  <span className="font-semibold text-emerald-700">{t(`host.status.${q.status}`)}</span>
                )}
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}
