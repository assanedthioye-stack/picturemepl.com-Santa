import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from './i18n';
import { Kiosk } from './pages/Kiosk';
import { StaffApp } from './pages/StaffApp';
import './index.css';

// One bundle, two surfaces: the family screen (/kiosk) and the staff app (everything else).
const isKiosk = location.pathname.startsWith('/kiosk');
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>{isKiosk ? <Kiosk /> : <StaffApp />}</I18nProvider>
  </StrictMode>,
);
