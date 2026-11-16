import https from 'node:https';
import { loadConfig } from './config';
import { startBooth } from './boot';

/** Entry point. Runs inside an Electron utilityProcess (or plain Node with `pnpm dev`). */
const config = loadConfig();
const booth = await startBooth(config);

// A stray rejected promise is logged, not fatal: a booth in the middle of an event must keep serving.
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e));

// shortcut: the server cert follows the IPs seen at startup; give the booth PC a DHCP reservation
let secure: https.Server | null = null;
booth.lanReady.then((tls) => {
  secure = https.createServer({ key: tls.key, cert: tls.cert }, booth.app);
  // The tablets' port being taken must not stop the booth PC itself from working.
  secure.on('error', (e) => console.error(`LAN https on port ${config.httpsPort} failed: ${e.message}`));
  secure.listen(config.httpsPort, '0.0.0.0', () => console.log(`LAN https on ${tls.ips.join(', ')}:${config.httpsPort}`));
}).catch((e) => console.error('LAN https setup failed:', e));

// Express 5 hands listen errors (port already in use…) to this callback instead of throwing.
const server = booth.app.listen(config.port, config.host, (err?: Error) => {
  if (err) {
    console.error(`cannot listen on ${config.host}:${config.port}: ${err.message}`);
    process.exit(1);
  }
  console.log(`booth-server listening on http://${config.host}:${config.port}`);
  // Tell Electron main we are ready (parentPort only exists in a utilityProcess).
  (process as unknown as { parentPort?: { postMessage(m: unknown): void } }).parentPort?.postMessage({ type: 'ready' });
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  secure?.close();
  await booth.stop().catch((e) => console.error('shutdown:', e));
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
