import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  app, BrowserWindow, dialog, Menu, powerSaveBlocker, screen, session, utilityProcess, type UtilityProcess,
} from 'electron';

const PORT = 4100;
const ORIGIN = `http://127.0.0.1:${PORT}`;
// Per-boot secret: only the kiosk window receives it, so nothing else can pose as the family screen.
const kioskToken = randomBytes(32).toString('base64url');

let server: UtilityProcess | null = null;
let staffWin: BrowserWindow | null = null;
let kioskWin: BrowserWindow | null = null;
let quitting = false;

// A second copy would fight the first one for the port, the database and the camera.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on('second-instance', () => { if (staffWin?.isMinimized()) staffWin.restore(); staffWin?.focus(); });

const resources = (dir: string, devPath: string) =>
  app.isPackaged ? path.join(process.resourcesPath, dir) : path.resolve(app.getAppPath(), devPath);

const MAX_FAILED_STARTS = 5;
let failedStarts = 0;

/**
 * booth-server runs in its own process: a native crash (EDSDK, printer driver) never takes the UI down.
 * It is restarted when it dies; `onReady` runs each time it comes up.
 */
function startServer(onReady: () => void): void {
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
  child.on('message', (m: { type?: string }) => {
    if (m?.type !== 'ready') return;
    failedStarts = 0;
    onReady();
  });
  child.on('exit', (code) => {
    if (server === child) server = null;
    if (quitting) return;
    // A server that never comes up (port taken, disk gone, damaged database) must be seen, not retried for ever behind no window.
    if (++failedStarts >= MAX_FAILED_STARTS) {
      dialog.showErrorBox('Picture Me Please', `Le serveur de la cabine ne démarre pas (code ${code}).\nThe booth server cannot start (code ${code}).`);
      app.quit();
      return;
    }
    console.error(`booth-server exited (${code}); restarting`);
    setTimeout(() => { if (!quitting) startServer(onReady); }, 1000);
  });
  server = child;
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
  staffWin.loadURL(ORIGIN).catch((e) => console.error('staff window failed to load', e));
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
    kioskWin.loadURL(`${ORIGIN}/kiosk/auth?token=${kioskToken}`).catch((e) => console.error('kiosk window failed to load', e));
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

app.whenReady().then(() => {
  if (!primary) return;
  if (app.isPackaged) Menu.setApplicationMenu(null);
  // Staff window: camera only (Host QR scanner), only for our own pages. Kiosk: nothing.
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb, details) =>
    cb(perm === 'media' && details.requestingUrl.startsWith(ORIGIN) && !('mediaTypes' in details && details.mediaTypes?.includes('audio'))));
  session.fromPartition('kiosk').setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  powerSaveBlocker.start('prevent-display-sleep');
  let opened = false;
  startServer(() => {
    if (opened) {
      // The server came back after a crash: its pages and event streams are stale.
      staffWin?.reload();
      kioskWin?.loadURL(`${ORIGIN}/kiosk/auth?token=${kioskToken}`).catch((e) => console.error('kiosk window failed to load', e));
      return;
    }
    opened = true;
    createStaffWindow();
    placeKiosk();
    for (const ev of ['display-added', 'display-removed', 'display-metrics-changed'] as const) {
      screen.on(ev as 'display-added', placeKiosk);
    }
  });
});

app.on('before-quit', () => {
  quitting = true;
  server?.kill();
});
app.on('window-all-closed', () => app.quit());
