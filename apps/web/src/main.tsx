import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Book } from './Book';
import { Booking } from './Booking';
import { setLocale, useT } from './i18n';
import './index.css';

function App() {
  const { t, locale } = useT();
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const f = () => setPath(location.pathname);
    addEventListener('popstate', f);
    return () => removeEventListener('popstate', f);
  }, []);
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  const token = /^\/b\/([A-Za-z0-9_-]{10,})$/.exec(path)?.[1];

  return (
    <>
      <header class="flex items-center justify-between bg-brand-600 px-4 py-3 text-white">
        <a href="/" class="text-lg font-bold">{t('title')}</a>
        <div class="flex gap-1 text-sm font-semibold" role="group" aria-label="Langue / Language">
          {(['fr', 'en'] as const).map((l) => (
            <button key={l} onClick={() => setLocale(l)} aria-pressed={locale === l}
              class={`rounded-md px-2.5 py-1 uppercase ${locale === l ? 'bg-white text-brand-700' : 'text-white/80'}`}>{l}</button>
          ))}
        </div>
      </header>
      {token ? <Booking token={token} /> : path === '/merci' ? <p class="mx-auto max-w-md p-6 text-center text-lg">{t('thanks')}</p> : <Book />}
    </>
  );
}

// Back from the payment page, browsers may restore this page frozen mid-request (buttons disabled): start clean.
addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });

render(<App />, document.getElementById('root')!);
