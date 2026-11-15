// usage: node tools/print-agent.js <serverUrl> <cashierPin> <mallId> <hotFolder> <photoDir>
// Copies paid orders' photos into the printer's hot folder, named by code, then marks the order printed.
const fs = require('node:fs');
const path = require('node:path');
const [url, pin, mall, hot, photoDir] = process.argv.slice(2);
if (!photoDir) { console.error('usage: print-agent <serverUrl> <pin> <mallId> <hotFolder> <photoDir>'); process.exit(1); }
const h = { 'x-pin': pin, 'content-type': 'application/json' };
let running = false;

async function tick() {
  if (running) return; // never overlap two polls: the same job would be copied twice
  running = true;
  try {
    const res = await fetch(`${url}/api/print/next?mall=${mall}`, { headers: h });
    if (!res.ok) throw new Error('server said ' + res.status);
    const job = await res.json();
    if (job) {
      const out = path.join(hot, path.basename(job.code));
      fs.mkdirSync(out, { recursive: true });
      for (const f of job.files) fs.copyFileSync(path.join(photoDir, path.basename(job.code), path.basename(f)), path.join(out, path.basename(f)));
      fs.writeFileSync(path.join(out, 'order.json'), JSON.stringify(job.lines, null, 2));
      const done = await fetch(`${url}/api/print/done`, { method: 'POST', headers: h, body: JSON.stringify({ code: job.code }) });
      if (!done.ok) throw new Error('could not mark printed: ' + done.status);
      console.log('queued for print', job.code);
    }
  } catch (e) { console.error(e.message); }
  running = false;
}
setInterval(tick, 3000);
