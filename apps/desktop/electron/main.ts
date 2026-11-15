import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  app, BrowserWindow, Menu, powerSaveBlocker, screen, session, utilityProcess, type UtilityProcess,
} from 'electron';

const PORT = 4100;
const ORIGIN = `http://127.0.0.1:${PORT}`;
// Per-boot secret: only the kiosk window receives it, so nothing else can pose as the family screen.
const kioskToken = randomBytes(32).toString('base64url');

let server: UtilityProcess | null = null;
let staffWin: BrowserWindow | null = null;
let kioskWin: BrowserWindow | null = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => staffWin?.focus());

const resources = (dir: string, devPath: string) =>
  app.isPackaged ? path.join(process.resourcesPath, dir) : path.resolve(app.getAppPath(), devPath);

/** booth-server runs in its own process: a native crash (EDSDK, printer driver) never takes the UI down. */
function startServer(): Promise<void> {
  return new Promise((resolve) => {
    const child = utilityProcess.fork(path.join(__dirname, 'server.mjs'), [], {
      serviceName: 'booth-server',
      stdio: 'inherit',
      env: {
        ...process.env,
        PMP_PORT: String(PORT),
        PMP_KIOSK_TOKEN: kioskToken,
        PMP_RENDERER_DIR: resources('renderer', 'dist/renderer'),
        PMP_MIGRATIONS_DIR: resources('migrations', '../../packages/db/drizzle'),
      },
    });
    child.on('message', (m: { type?: string }) => m?.type === 'ready' && resolve());
    child.on('exit', (code) => {
      server = null;
      if (quitting) return;
      console.error(`booth-server exited (${code}); restarting`);
      setTimeout(() => startServer().then(() => { staffWin?.reload(); kioskWin?.reload(); }), 1000);
    });
    server = child;
  });
}

/** Keep every window on our origin: no stray links, popups or file:// navigation. */
function lockDown(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(ORIGIN)) e.preventDefault(); });
}

function createStaffWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  staffWin = new BrowserWindow({
    ...workArea,
    title: 'Picture Me Please',
    backgroundColor: '#f8fafc',
    webPreferences: { sandbox: true, contextIsolation: true, devTools: !app.isPackaged },
  });
  staffWin.maximize();
  lockDown(staffWin);
  staffWin.loadURL(ORIGIN);
  staffWin.on('closed', () => { staffWin = null; app.quit(); });
}

function kioskDisplay() {
  const primary = screen.getPrimaryDisplay();
  const wanted = Number(process.env.PMP_KIOSK_DISPLAY_ID);
  const all = screen.getAllDisplays();
  return all.find((d) => d.id === wanted) ?? all.find((d) => d.id !== primary.id) ?? null;
}

/** Customer screen pinned to the secondary monitor; follows plug/unplug. */
function placeKiosk() {
  const target = kioskDisplay();
  if (!target) {
    kioskWin?.hide(); // single screen: nothing to show the family
    return;
  }
  if (!kioskWin) {
    kioskWin = new BrowserWindow({
      ...target.bounds,
      show: false,
      frame: false,
      kiosk: true,
      fullscreen: true,
      backgroundColor: '#0b0b0f',
      skipTaskbar: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        devTools: !app.isPackaged,
        partition: 'kiosk', // separate cookie jar: the family screen never shares the staff login
      },
    });
    lockDown(kioskWin);
    kioskWin.webContents.setVisualZoomLevelLimits(1, 1); // no pinch-zoom on touch screens
    kioskWin.on('close', (e) => { if (!quitting) e.preventDefault(); });
    kioskWin.loadURL(`${ORIGIN}/kiosk/auth?token=${kioskToken}`);
    kioskWin.once('ready-to-show', () => kioskWin?.show());
  }
  // Leave fullscreen before moving, otherwise Windows keeps it on the old display.
  kioskWin.setKiosk(false);
  kioskWin.setFullScreen(false);
  kioskWin.setBounds(target.bounds);
  kioskWin.setFullScreen(true);
  kioskWin.setKiosk(true);
  kioskWin.showInactive(); // never steal focus from the staff window
}

app.whenReady().then(async () => {
  if (app.isPackaged) Menu.setApplicationMenu(null);
  // Deny camera/mic/geolocation etc.; the UI needs none of them.
  for (const s of [session.defaultSession, session.fromPartition('kiosk')]) {
    s.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  }
  powerSaveBlocker.start('prevent-display-sleep');
  await startServer();
  createStaffWindow();
  placeKiosk();
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed'] as const) {
    screen.on(ev as 'display-added', placeKiosk);
  }
});

app.on('before-quit', () => {
  quitting = true;
  server?.kill();
});
app.on('window-all-closed', () => app.quit());
