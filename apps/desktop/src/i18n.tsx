import { createContext, useContext, useState, type ReactNode } from 'react';
import { translate, type Locale, type MessageKey } from '@pmp/shared';

const KEY = 'pmp.locale';
function stored(): Locale {
  try { return localStorage.getItem(KEY) === 'en' ? 'en' : 'fr'; } catch { return 'fr'; }
}

const Ctx = createContext<{ locale: Locale; setLocale(l: Locale): void; t(k: MessageKey): string }>({
  locale: 'fr', setLocale: () => {}, t: (k) => translate('fr', k),
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, set] = useState<Locale>(stored);
  const setLocale = (l: Locale) => {
    set(l);
    document.documentElement.lang = l;
    try { localStorage.setItem(KEY, l); } catch { /* private mode */ }
  };
  return <Ctx.Provider value={{ locale, setLocale, t: (k) => translate(locale, k) }}>{children}</Ctx.Provider>;
}

export const useT = () => useContext(Ctx);

export function LangToggle({ dark = false }: { dark?: boolean }) {
  const { locale, setLocale } = useT();
  const base = dark ? 'text-white/60 hover:text-white' : 'text-slate-500 hover:text-slate-900';
  return (
    <div className="flex gap-1 text-sm font-semibold" role="group" aria-label="Langue / Language">
      {(['fr', 'en'] as const).map((l) => (
        <button key={l} onClick={() => setLocale(l)} aria-pressed={locale === l}
          className={`rounded-md px-2.5 py-1.5 uppercase ${locale === l ? (dark ? 'bg-white/15 text-white' : 'bg-slate-900 text-white') : base}`}>
          {l}
        </button>
      ))}
    </div>
  );
}
