// usage: node tools/uploader.js <watchDir> <serverUrl> <photographerPin> <mallId>
const fs = require('node:fs');
const path = require('node:path');
const [dir, url, pin, mall] = process.argv.slice(2);
if (!mall) { console.error('usage: uploader <watchDir> <serverUrl> <pin> <mallId>'); process.exit(1); }
const seen = new Set();

async function upload(file, tries = 2) {
  try {
    const res = await fetch(`${url}/api/photos?mall=${mall}&name=${encodeURIComponent(path.basename(file))}`, {
      method: 'POST', headers: { 'x-pin': pin }, body: fs.readFileSync(file) });
    if (!res.ok) console.error('REJECTED', file, (await res.json()).error); // e.g. no active family: re-shoot
    else console.log('uploaded', file);
  } catch (e) {
    if (tries > 1) return setTimeout(() => upload(file, tries - 1), 2000);
    console.error('FAILED', file, e.message);
  }
}
fs.watch(dir, (_, name) => {
  if (!name || !/\.jpe?g$/i.test(name) || seen.has(name)) return;
  seen.add(name);
  setTimeout(() => upload(path.join(dir, name)), 1000); // let the camera finish writing the file
});
console.log('watching', dir);
