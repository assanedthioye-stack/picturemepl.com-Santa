import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { api, useEvents, type PhotoDto } from '../api';
import { LangToggle, money, useT } from '../i18n';

interface KioskState { session: { id: string; code: string } | null; photos: PhotoDto[] }

/** Family-facing touch screen on the secondary monitor: live shots + favourite picking. */
export function Kiosk() {
  const { t, locale } = useT();
  const [state, setState] = useState<KioskState>({ session: null, photos: [] });
  const [selected, setSelected] = useState<string | null>(null);
  const lastTouch = useRef(0);
  const [pay, setPay] = useState<{ url: string; amountXof: number } | null>(null);

  useEffect(() => { api<KioskState>('GET', '/api/kiosk/state').then(setState, () => {}); }, []);

  useEvents({
    'kiosk.state': (s: KioskState) => { setState(s); setSelected(null); },
    'kiosk.payment': setPay,
    'photo.ready': (p: PhotoDto) => {
      setState((s) => (s.session?.id === p.sessionId && !s.photos.some((x) => x.id === p.id) ? { ...s, photos: [...s.photos, p] } : s));
      // A new shot takes the big frame unless the family touched the screen in the last 8 s.
      if (Date.now() - lastTouch.current > 8000) setSelected(p.id);
    },
    'photo.updated': (p: PhotoDto) => setState((s) => ({
      ...s,
      photos: p.hidden ? s.photos.filter((x) => x.id !== p.id) : s.photos.map((x) => (x.id === p.id ? p : x)),
    })),
  });

  const touch = () => { lastTouch.current = Date.now(); };
  const toggle = async (p: PhotoDto) => {
    touch();
    const next = !p.favorite;
    setState((s) => ({ ...s, photos: s.photos.map((x) => (x.id === p.id ? { ...x, favorite: next } : x)) }));
    await api('POST', `/api/kiosk/photos/${p.id}/favorite`, { favorite: next }).catch(() =>
      setState((s) => ({ ...s, photos: s.photos.map((x) => (x.id === p.id ? { ...x, favorite: p.favorite } : x)) })));
  };

  const photos = state.photos;
  const hero = photos.find((p) => p.id === selected) ?? photos[photos.length - 1];
  const favs = photos.filter((p) => p.favorite).length;

  return (
    <div className="relative flex h-full flex-col bg-[#0b0b0f] text-white" onPointerDown={touch}>
      {pay && (
        <div className="absolute inset-0 z-10 grid place-items-center bg-black/85" role="dialog" aria-modal="true" aria-label={t('kiosk.pay.title')}>
          <div className="flex flex-col items-center gap-5 rounded-3xl bg-white p-10 text-slate-900">
            <p className="text-4xl font-bold">{t('kiosk.pay.title')}</p>
            <p className="text-5xl font-bold text-brand-600">{money(locale, pay.amountXof)}</p>
            {/* High contrast, high error correction: phone cameras read it off a bright screen. */}
            <QRCodeSVG value={pay.url} size={360} level="H" marginSize={4} bgColor="#ffffff" fgColor="#000000" />
            <p className="text-xl text-slate-600">{t('kiosk.pay.sub')}</p>
          </div>
        </div>
      )}
      <header className="flex items-center gap-4 px-8 py-5">
        <span className="text-xl font-bold text-brand-500">Picture Me Please</span>
        {state.session && photos.length > 0 && (
          <span className="text-white/70" aria-live="polite">♥ {favs} {t('kiosk.favorites')}</span>
        )}
        <div className="flex-1" />
        <LangToggle dark />
      </header>

      {!state.session || photos.length === 0 ? (
        <main className="grid flex-1 place-items-center px-8 text-center">
          <div>
            <p className="text-6xl font-bold">{t('kiosk.welcome')}</p>
            <p className="mt-4 text-2xl text-white/60">{t('kiosk.welcome.sub')}</p>
          </div>
        </main>
      ) : (
        <main className="grid min-h-0 flex-1 grid-cols-1 gap-6 px-8 pb-8 lg:grid-cols-[1fr_22rem]">
          <section className="relative min-h-0 overflow-hidden rounded-3xl bg-black">
            {hero && (
              <>
                <img key={hero.id} src={hero.previewUrl} alt={`Photo ${hero.seq}`} className="pop-in size-full object-contain" />
                <span className="absolute left-5 top-5 rounded-xl bg-black/60 px-4 py-2 text-3xl font-bold">#{hero.seq}</span>
                <button onClick={() => toggle(hero)} aria-pressed={hero.favorite} aria-label="♥"
                  className={`absolute bottom-6 right-6 grid size-24 place-items-center rounded-full text-5xl shadow-2xl transition active:scale-90 ${hero.favorite ? 'bg-brand-500 text-white' : 'bg-white/90 text-brand-500'}`}>
                  ♥
                </button>
              </>
            )}
          </section>

          <aside className="flex min-h-0 flex-col gap-3">
            <p className="text-white/60">{t('kiosk.tap')}</p>
            <ul className="grid min-h-0 grid-cols-3 gap-3 overflow-y-auto lg:grid-cols-2">
              {photos.map((p) => (
                <li key={p.id} className="pop-in">
                  <button onClick={() => { touch(); setSelected(p.id); }} aria-label={`Photo ${p.seq}`}
                    className={`relative block w-full overflow-hidden rounded-xl ring-4 ${p.id === hero?.id ? 'ring-gold-400' : 'ring-transparent'}`}>
                    <img src={p.previewUrl} alt="" loading="lazy" className="aspect-[3/2] w-full object-cover" />
                    <span className="absolute left-1.5 top-1.5 rounded bg-black/60 px-1.5 text-sm font-bold">#{p.seq}</span>
                    {p.favorite && <span className="absolute right-1.5 top-1 text-2xl text-brand-500 drop-shadow">♥</span>}
                  </button>
                </li>
              ))}
            </ul>
          </aside>
        </main>
      )}
    </div>
  );
}
