import { useEffect, useState } from 'react';
import { can } from '@pmp/shared';
import { api, type Me } from '../api';
import { LangToggle, useT } from '../i18n';
import { Login } from './Login';
import { Photographer } from './Photographer';

export function StaffApp() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [screen, setScreen] = useState<'home' | 'photographer'>('home');
  const { setLocale } = useT();

  useEffect(() => { api<Me>('GET', '/api/auth/me').then(setMe, () => setMe(null)); }, []);

  const signIn = (u: Me) => { setLocale(u.locale); setMe(u); setScreen(u.role === 'photographer' ? 'photographer' : 'home'); };
  const signOut = async () => { await api('POST', '/api/auth/logout').catch(() => {}); setMe(null); };

  if (me === undefined) return null;
  if (!me) return <Login onSignedIn={signIn} />;
  if (screen === 'photographer' && can(me.role, 'session.shoot')) {
    return <Photographer me={me} onSignOut={signOut} onBack={me.role === 'photographer' ? undefined : () => setScreen('home')} />;
  }
  return <RoleHome me={me} onSignOut={signOut} onOpen={setScreen} />;
}

/** Landing page for roles whose screens arrive in Phase 2; links to what the role may already use. */
function RoleHome({ me, onSignOut, onOpen }: { me: Me; onSignOut(): void; onOpen(s: 'photographer'): void }) {
  const { t } = useT();
  return (
    <div className="flex h-full flex-col">
      <TopBar me={me} onSignOut={onSignOut} />
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center gap-6 p-6 text-center">
        <h1 className="text-2xl font-semibold">{t(`role.${me.role}`)}</h1>
        <p className="text-slate-600">{t('home.phase2')}</p>
        {can(me.role, 'session.shoot') && (
          <button onClick={() => onOpen('photographer')} className="rounded-xl bg-brand-600 px-6 py-3 font-semibold text-white hover:bg-brand-700">
            {t('home.open.photographer')}
          </button>
        )}
      </main>
    </div>
  );
}

export function TopBar({ me, onSignOut, children }: { me: Me; onSignOut(): void; children?: React.ReactNode }) {
  const { t } = useT();
  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
      <span className="font-bold text-brand-600">Picture Me Please</span>
      <span className="text-sm text-slate-500">{me.fullName} · {t(`role.${me.role}`)}</span>
      <div className="flex-1" />
      {children}
      <LangToggle />
      <button onClick={onSignOut} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100">
        {t('logout')}
      </button>
    </header>
  );
}
