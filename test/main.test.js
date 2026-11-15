const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The hosting platform loads the entry file itself and expects it to call listen() with no "run directly" guard.
for (const entry of ['index.js', 'main.js']) test(`server/${entry} starts listening on PORT and serves the booking page`, async () => {
  const port = 34000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [path.join(__dirname, '../server', entry)], {
    env: { ...process.env, PORT: String(port), PINS: '{"host":"1111","photographer":"2222","cashier":"3333","monitor":"4444","admin":"9999"}', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'pmp-')) },
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
