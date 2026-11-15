import { useEffect, useState } from 'react';
import { api, ApiError, type Me } from '../api';
import { LangToggle, useT } from '../i18n';

interface Tile { id: string; fullName: string; role: Me['role'] }

/** POS-style sign-in: tap your name, then your PIN (admins type a password). */
export function Login({ onSignedIn }: { onSignedIn(me: Me): void }) {
  const { t } = useT();
  const [staff, setStaff] = useState<Tile[]>([]);
  const [who, setWho] = useState<Tile | null>(null);
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api<Tile[]>('GET', '/api/auth/staff').then(setStaff, () => setError(t('error.generic'))); }, []);

  async function submit(value = secret) {
    if (!who || busy) return;
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await api<Me>('POST', '/api/auth/login', { userId: who.id, secret: value }));
    } catch (e) {
      setError(e instanceof ApiError && e.status === 423 ? t('login.error.locked') : t('login.error.invalid'));
      setSecret('');
    } finally {
      setBusy(false);
    }
  }

  const press = (d: string) => {
    if (busy) return;
    const next = (secret + d).slice(0, 6);
    setSecret(next);
    setError(null);
  };

  return (
    <div className="flex h-full flex-col bg-gradient-to-b from-brand-50 to-white">
      <header className="flex items-center justify-between px-6 py-4">
        <span className="text-lg font-bold text-brand-600">{t('app.title')}</span>
        <LangToggle />
      </header>
      <main className="flex flex-1 items-center justify-center p-6">
        {!who ? (
          <section className="w-full max-w-3xl">
            <h1 className="mb-6 text-center text-2xl font-semibold">{t('login.choose')}</h1>
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
              {staff.map((s) => (
                <li key={s.id}>
                  <button onClick={() => { setWho(s); setSecret(''); setError(null); }}
                    className="flex w-full flex-col items-center gap-2 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm hover:border-brand-500 focus-visible:outline-2 focus-visible:outline-brand-500">
                    <span className="grid size-14 place-items-center rounded-full bg-brand-100 text-xl font-bold text-brand-700" aria-hidden>
                      {s.fullName.split(' ').map((w) => w[0]).slice(0, 2).join('')}
                    </span>
                    <span className="font-medium">{s.fullName}</span>
                    <span className="text-xs uppercase tracking-wide text-slate-500">{t(`role.${s.role}`)}</span>
                  </button>
                </li>
              ))}
            </ul>
            {error && <p role="alert" className="mt-4 text-center text-brand-600">{error}</p>}
          </section>
        ) : (
          <section className="w-full max-w-xs text-center">
            <p className="text-lg font-semibold">{who.fullName}</p>
            {who.role === 'admin' ? (
              <form className="mt-6 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
                <label className="text-left text-sm text-slate-600" htmlFor="pw">{t('login.password')}</label>
                <input id="pw" type="password" autoFocus autoComplete="current-password" value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  className="rounded-xl border border-slate-300 px-4 py-3 text-lg focus:border-brand-500 focus:outline-none" />
                <button disabled={busy || secret.length < 10} className="rounded-xl bg-brand-600 py-3 font-semibold text-white disabled:opacity-40">
                  {t('login.submit')}
                </button>
              </form>
            ) : (
              <>
                <p className="mt-1 text-sm text-slate-600">{t('login.pin')}</p>
                <div className="my-5 flex justify-center gap-3" aria-live="polite" aria-label={`${secret.length} / 6`}>
                  {Array.from({ length: 6 }, (_, i) => (
                    <span key={i} className={`size-4 rounded-full border-2 ${i < secret.length ? 'border-brand-600 bg-brand-600' : 'border-slate-300'}`} />
                  ))}
                </div>
                <div className="grid grid-cols-3 gap-3">
                  {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <Key key={d} onClick={() => press(d)}>{d}</Key>)}
                  <Key onClick={() => setSecret(secret.slice(0, -1))} label="⌫">⌫</Key>
                  <Key onClick={() => press('0')}>0</Key>
                  <Key onClick={() => submit()} disabled={secret.length < 4 || busy} primary label={t('login.submit')}>✓</Key>
                </div>
              </>
            )}
            {error && <p role="alert" className="mt-4 font-medium text-brand-600">{error}</p>}
            <button onClick={() => setWho(null)} className="mt-6 text-sm text-slate-500 underline">{t('login.back')}</button>
          </section>
        )}
      </main>
    </div>
  );
}

function Key(p: { onClick(): void; children: React.ReactNode; disabled?: boolean; primary?: boolean; label?: string }) {
  return (
    <button onClick={p.onClick} disabled={p.disabled} aria-label={p.label}
      className={`h-16 rounded-2xl text-2xl font-semibold shadow-sm disabled:opacity-40 ${p.primary ? 'bg-brand-600 text-white' : 'border border-slate-200 bg-white active:bg-slate-100'}`}>
      {p.children}
    </button>
  );
}
