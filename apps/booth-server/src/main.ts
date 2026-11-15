import { loadConfig } from './config';
import { startBooth } from './boot';

/** Entry point. Runs inside an Electron utilityProcess (or plain Node with `pnpm dev`). */
const config = loadConfig();
const booth = await startBooth(config);
const server = booth.app.listen(config.port, config.host, () => {
  console.log(`booth-server listening on http://${config.host}:${config.port}`);
  // Tell Electron main we are ready (parentPort only exists in a utilityProcess).
  (process as unknown as { parentPort?: { postMessage(m: unknown): void } }).parentPort?.postMessage({ type: 'ready' });
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  await booth.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
