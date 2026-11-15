const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The hosting platform loads the entry file itself and expects it to call listen() with no "run directly" guard.
test('server/main.js starts listening on PORT and serves the booking page', async () => {
  const port = 34000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [path.join(__dirname, '../server/main.js')], {
    env: { ...process.env, PORT: String(port), PINS: '{"admin":"1"}', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'pmp-')) },
  });
  try {
    let res;
    for (let i = 0; i < 40 && !res; i++) {
      res = await fetch(`http://localhost:${port}/api/malls`).catch(() => null);
      if (!res) await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(res, 'server never listened');
    assert.equal(res.status, 200);
    assert.equal((await fetch(`http://localhost:${port}/book.html`)).status, 200);
  } finally { child.kill(); }
});
