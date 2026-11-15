import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';

/** Camera QR reader (jsQR; works in Electron on Windows where BarcodeDetector is missing). Needs HTTPS or localhost. */
export function QrScanner({ onCode, onClose }: { onCode(text: string): void; onClose(): void }) {
  const { t } = useT();
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer = 0;
    let stopped = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    (async () => {
      try {
        const [{ default: jsQR }, s] = await Promise.all([
          import('jsqr'), // only the Host screen pays for the decoder
          navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false }),
        ]);
        stream = s;
        if (stopped) return s.getTracks().forEach((tr) => tr.stop());
        video.current!.srcObject = s;
        await video.current!.play();
        const tick = () => {
          const v = video.current;
          if (stopped || !v) return;
          if (v.videoWidth) {
            // Decode a downscaled frame: fast enough on entry-level tablets.
            const scale = Math.min(1, 640 / v.videoWidth);
            canvas.width = v.videoWidth * scale;
            canvas.height = v.videoHeight * scale;
            ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
            const hit = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
            if (hit?.data) return onCode(hit.data);
          }
          timer = window.setTimeout(tick, 200);
        };
        tick();
      } catch {
        setError(true);
      }
    })();
    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [onCode]);

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <p role="alert" className="rounded-lg bg-amber-50 p-3 text-amber-800">{t('host.scan.error')}</p>
      ) : (
        <div className="relative overflow-hidden rounded-xl bg-black">
          <video ref={video} muted playsInline className="aspect-video w-full object-cover" />
          <div className="pointer-events-none absolute inset-[20%] rounded-2xl border-4 border-white/80" aria-hidden />
        </div>
      )}
      <button onClick={onClose} className="rounded-lg border border-slate-300 py-2 font-medium">{t('host.scan.stop')}</button>
    </div>
  );
}
