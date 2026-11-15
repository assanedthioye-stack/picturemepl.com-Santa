// usage: node tools/uploader.js <watchDir> <serverUrl> <photographerPin> <mallId>
const fs = require('node:fs');
const path = require('node:path');
const [dir, url, pin, mall] = process.argv.slice(2);
if (!mall) { console.error('usage: uploader <watchDir> <serverUrl> <pin> <mallId>'); process.exit(1); }
const seen = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The camera writes a file in pieces: wait until its size stops changing before reading it.
async function settled(file) {
  let last = -1;
  for (let i = 0; i < 60; i++) {
    const size = fs.statSync(file).size;
    if (size > 0 && size === last) return;
    last = size;
    await sleep(500);
  }
  throw new Error('file never finished writing');
}

async function upload(file) {
  try {
    await settled(file);
    const body = fs.readFileSync(file);
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(`${url}/api/photos?mall=${mall}&name=${encodeURIComponent(path.basename(file))}`, { method: 'POST', headers: { 'x-pin': pin }, body });
        // A rejected shot is NOT retried: by then another family may be in front of the camera.
        if (!res.ok) console.error('REJECTED', file, (await res.json().catch(() => ({}))).error || res.status);
        else console.log('uploaded', file);
        return;
      } catch (e) {
        if (attempt >= 3) throw e;
        await sleep(2000);
      }
    }
  } catch (e) { console.error('FAILED', file, e.message); }
}
fs.watch(dir, (_, name) => {
  if (!name || !/\.(jpe?g|png)$/i.test(name) || seen.has(name) || !fs.existsSync(path.join(dir, name))) return;
  seen.add(name);
  upload(path.join(dir, name));
});
console.log('watching', dir);
