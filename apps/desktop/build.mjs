// Bundles Electron main (CJS) and booth-server (ESM, utilityProcess). Native modules stay external.
import { cpSync } from 'node:fs';
import { build } from 'esbuild';

const external = ['electron', 'better-sqlite3', 'sharp', '@node-rs/argon2', 'pdf-to-printer', '@brick-a-brack/napi-canon-cameras'];
const common = { bundle: true, platform: 'node', target: 'node22', external, sourcemap: true, logLevel: 'info' };

await build({ ...common, entryPoints: ['electron/main.ts'], format: 'cjs', outfile: 'dist-electron/main.cjs' });
await build({
  ...common,
  entryPoints: ['../booth-server/src/main.ts'],
  format: 'esm',
  outfile: 'dist-electron/server.mjs',
  // Bundled CommonJS deps (express…) call require() for Node built-ins.
  banner: { js: "import { createRequire as __pmpRequire } from 'node:module'; const require = __pmpRequire(import.meta.url);" },
});
cpSync('../booth-server/src/camera/wia-poll.ps1', 'dist-electron/wia-poll.ps1');
