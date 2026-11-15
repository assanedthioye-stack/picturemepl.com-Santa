// usage: node tools/print-agent.js <serverUrl> <cashierPin> <mallId> <hotFolder> <photoDir>
// Copies paid orders' photos into the printer's hot folder, named by code, then marks the order printed.
const fs = require('node:fs');
const path = require('node:path');
const [url, pin, mall, hot, photoDir] = process.argv.slice(2);
if (!photoDir) { console.error('usage: print-agent <serverUrl> <pin> <mallId> <hotFolder> <photoDir>'); process.exit(1); }
const h = { 'x-pin': pin, 'content-type': 'application/json' };

async function tick() {
  try {
    const job = await (await fetch(`${url}/api/print/next?mall=${mall}`, { headers: h })).json();
    if (job) {
      const out = path.join(hot, job.code);
      fs.mkdirSync(out, { recursive: true });
      for (const f of job.files) fs.copyFileSync(path.join(photoDir, job.code, f), path.join(out, f));
      fs.writeFileSync(path.join(out, 'order.json'), JSON.stringify(job.lines, null, 2));
      await fetch(`${url}/api/print/done`, { method: 'POST', headers: h, body: JSON.stringify({ code: job.code }) });
      console.log('queued for print', job.code);
    }
  } catch (e) { console.error(e.message); }
}
setInterval(tick, 3000);
