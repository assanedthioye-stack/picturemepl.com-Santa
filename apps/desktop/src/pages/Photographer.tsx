import { useCallback, useEffect, useRef, useState } from 'react';
import { api, useEvents, type CameraInfo, type Me, type PhotoDto, type SessionRow, type StorageInfo, type SyncInfo } from '../api';
import { useT } from '../i18n';
import { TopBar } from './StaffApp';

export function Photographer({ me, onSignOut, nav }: { me: Me; onSignOut(): void; nav?: React.ReactNode }) {
  const { t } = useT();
  const [camera, setCamera] = useState<CameraInfo | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [photos, setPhotos] = useState<PhotoDto[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [shooting, setShooting] = useState(false);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [incoming, setIncoming] = useState<SessionRow | null>(null);
  const known = useRef<Set<string> | null>(null);

  const armed = sessions.find((s) => s.status === 'armed') ?? null;

  const refresh = useCallback(async () => {
    const [cams, list] = await Promise.all([api<CameraInfo[]>('GET', '/api/cameras'), api<SessionRow[]>('GET', '/api/sessions')]);
    setCamera(cams[0] ?? null);
    setSessions(list);
    // A family the Host just sent: flash it (not on first load).
    const fresh = list.find((s) => s.status === 'dispatched' && known.current && !known.current.has(s.id));
    if (fresh) setIncoming(fresh);
    known.current = new Set(list.map((s) => s.id));
    const current = list.find((s) => s.status === 'armed');
    setPhotos(current ? await api<PhotoDto[]>('GET', `/api/sessions/${current.id}/photos`) : []);
  }, []);
  useEffect(() => { refresh().catch(() => setNotice(t('error.generic'))); }, [refresh]);
  useEffect(() => { api<StorageInfo>('GET', '/api/storage').then(setStorage, () => {}); }, []);

  const reload = () => { refresh().catch(() => setNotice(t('error.generic'))); };
  useEvents({
    // Disk status and cloud status arrive separately: keep the half the event does not carry.
    'storage.status': (s: StorageInfo) => setStorage((old) => ({ ...s, cloud: old?.cloud })),
    'sync.status': (c: SyncInfo | null) => setStorage((old) => old && { ...old, cloud: c }),
    'camera.status': (s) => setCamera((c) => (c && c.id === s.cameraId ? { ...c, ...s } : c)),
    'session.updated': () => void refresh(),
    'photo.ready': (p: PhotoDto) => setPhotos((ps) => (p.sessionId === armed?.id && !ps.some((x) => x.id === p.id) ? [...ps, p] : ps)),
    'photo.updated': (p: PhotoDto) => setPhotos((ps) => ps.map((x) => (x.id === p.id ? p : x))),
    'photo.unassigned': () => setNotice(t('photos.unassigned')),
    'photo.failed': (e: { error: string }) => setNotice(e.error),
  }, reload);

  const act = async (fn: () => Promise<unknown>) => {
    setNotice(null);
    try { await fn(); await refresh(); } catch (e) { setNotice((e as Error).message); }
  };

  const shoot = async () => {
    if (!camera) return;
    setShooting(true);
    await act(() => api('POST', `/api/cameras/${camera.id}/shutter`));
    setShooting(false);
  };

  return (
    <div className="flex h-full flex-col">
      <TopBar me={me} onSignOut={onSignOut}>
        {nav}
        <StoragePill storage={storage} />
        <CameraPill camera={camera} />
      </TopBar>

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[20rem_1fr]">
        <aside className="overflow-y-auto border-r border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">{t('sessions.title')}</h2>
          {sessions.length === 0 && <p className="text-slate-500">{t('sessions.none')}</p>}
          <ul className="flex flex-col gap-2">
            {sessions.map((s) => (
              <li key={s.id} className={`rounded-xl border p-3 ${s.status === 'armed' ? 'border-brand-500 bg-brand-50' : 'border-slate-200'}`}>
                <p className="truncate text-lg font-semibold">{s.familyName ?? '—'}</p>
                <div className="flex items-baseline justify-between">
                  <span className="font-mono text-2xl font-bold tracking-widest">{s.code}</span>
                  <span className="text-xs text-slate-500">{s.bookingCode} · {s.partySize} {t('sessions.party')}</span>
                </div>
                {s.status === 'armed' ? (
                  <p className="mt-2 text-center font-semibold text-brand-700">● {t('sessions.armed')}</p>
                ) : (
                  <button disabled={!!armed} onClick={() => act(() => api('POST', `/api/sessions/${s.id}/arm`))}
                    className="mt-2 w-full rounded-lg bg-brand-600 py-2 font-semibold text-white disabled:opacity-30">{t('sessions.arm')}</button>
                )}
              </li>
            ))}
          </ul>
          <button onClick={() => act(() => api('POST', '/api/kiosk/clear'))}
            className="mt-6 w-full rounded-lg border border-slate-300 py-2 text-sm text-slate-600 hover:bg-slate-50">{t('kiosk.clear')}</button>
        </aside>

        <main className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
          {incoming && !armed && (
            <button onClick={() => setIncoming(null)} role="alert"
              className="pop-in flex items-center gap-4 rounded-2xl border-2 border-brand-500 bg-brand-50 p-4 text-left">
              <span className="text-sm font-semibold uppercase tracking-wide text-brand-700">{t('ph.new')}</span>
              <span className="text-2xl font-bold">{incoming.familyName}</span>
              <span className="font-mono text-2xl font-bold tracking-widest text-brand-700">{incoming.code}</span>
            </button>
          )}
          {armed && (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-2xl bg-slate-900 p-4 text-white">
              <span className="text-sm uppercase tracking-wide text-white/60">{t('ph.active')}</span>
              <span className="text-2xl font-bold">{armed.familyName ?? '—'}</span>
              <span className="font-mono text-2xl font-bold tracking-widest text-gold-400">{armed.code}</span>
              <span className="text-xl"><b>{photos.length}</b> {t('ph.photos')}</span>
              <button onClick={() => act(() => api('POST', `/api/sessions/${armed.id}/complete`))}
                className="ml-auto rounded-xl bg-brand-600 px-5 py-3 font-bold">{t('ph.finish')} →</button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-4">
            {camera?.canRemoteShutter ? (
              <button onClick={shoot} disabled={!armed || !camera.connected || shooting}
                className="rounded-full bg-brand-600 px-10 py-5 text-xl font-bold text-white shadow-lg active:scale-95 disabled:opacity-30">
                ● {t('camera.trigger')}
              </button>
            ) : (
              <p className="rounded-lg bg-amber-50 px-4 py-3 text-amber-800">{t('camera.trigger.unsupported')}</p>
            )}
            {!armed && <p className="text-slate-500">{t('camera.noSession')}</p>}
            {notice && <p role="alert" className="rounded-lg bg-brand-50 px-3 py-2 text-brand-700">{notice}</p>}
          </div>

          {photos.length === 0 ? (
            <p className="grid flex-1 place-items-center text-slate-400">{t('photos.empty')}</p>
          ) : (
            <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {photos.map((p) => (
                <li key={p.id} className={`pop-in relative overflow-hidden rounded-xl bg-slate-200 ${p.hidden ? 'opacity-35' : ''}`}>
                  <img src={p.previewUrl} alt={`#${p.seq}`} className="aspect-[3/2] w-full object-cover" />
                  <span className="absolute left-2 top-2 rounded-md bg-black/60 px-2 py-0.5 text-sm font-bold text-white">#{p.seq}</span>
                  {p.favorite && <span className="absolute right-2 top-2 text-xl text-brand-500" aria-label="favorite">♥</span>}
                  <button onClick={() => act(() => api('POST', `/api/photos/${p.id}/hidden`, { hidden: !p.hidden }))}
                    className="absolute bottom-2 right-2 rounded-md bg-white/90 px-2 py-1 text-xs font-semibold">
                    {p.hidden ? t('photos.show') : t('photos.hide')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </main>
      </div>
    </div>
  );
}

function CameraPill({ camera }: { camera: CameraInfo | null }) {
  const { t } = useT();
  const ok = camera?.connected;
  const battery = camera?.onAcPower ? t('camera.ac') : camera?.batteryPercent != null ? `${camera.batteryPercent}%` : '—';
  const low = !camera?.onAcPower && camera?.batteryPercent != null && camera.batteryPercent <= 20;
  return (
    <div className="flex items-center gap-2 rounded-full border border-slate-200 px-3 py-1.5 text-sm" title={camera?.error ?? undefined}>
      <span className={`size-2.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-slate-400'}`} aria-hidden />
      <span className="font-medium">{ok ? camera?.model ?? t('camera.connected') : t('camera.disconnected')}</span>
      <span className={low ? 'font-semibold text-brand-600' : 'text-slate-500'}>{t('camera.battery')} {battery}</span>
      <span className="text-xs uppercase text-slate-400">{camera?.driver ?? '—'}</span>
    </div>
  );
}

/** Backup + free-space health. Red means act now: plug the backup drive back in, or free space. */
function StoragePill({ storage }: { storage: StorageInfo | null }) {
  const { t } = useT();
  if (!storage) return null;
  const m = storage.mirror;
  const [tone, label] = !m.enabled ? ['amber', t('storage.backup.off')]
    : !m.connected ? ['red', t('storage.backup.missing')]
    : m.pending > 0 ? ['amber', `${t('storage.backup.pending')} (${m.pending})`]
    : ['green', t('storage.backup.ok')];
  const low = storage.photosLow || m.low;
  const free = storage.photosFreeGb != null ? `${Math.round(storage.photosFreeGb)} ${t('storage.free')}` : '';
  const dot = { green: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-brand-600' }[tone as 'green'];
  return (
    <div role="status" title={m.lastError ?? undefined}
      className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${tone === 'red' || low ? 'border-brand-500 bg-brand-50' : 'border-slate-200'}`}>
      <span className={`size-2.5 rounded-full ${dot}`} aria-hidden />
      <span className="font-medium">{label}</span>
      <span className={low ? 'font-semibold text-brand-600' : 'text-slate-500'}>{low ? `${t('storage.low')} · ` : ''}{free}</span>
      {storage.cloud && !storage.cloud.ok && (
        <span className="font-semibold text-amber-700" title={storage.cloud.lastError ?? undefined}>· {t('sync.offline')}</span>
      )}
    </div>
  );
}
