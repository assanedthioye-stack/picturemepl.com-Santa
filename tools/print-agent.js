// usage: node tools/print-agent.js <serverUrl> <printerPin> <mallId> <hotFolder>
// Fetches the clean photos of PAID orders from the server into the printer's hot folder, then marks the order printed.
// <printerPin> is the "printer" PIN (or the admin PIN if no printer PIN is configured).
const fs = require('node:fs');
const path = require('node:path');
const [url, pin, mall, hot] = process.argv.slice(2);
if (!hot) { console.error('usage: print-agent <serverUrl> <printerPin> <mallId> <hotFolder>'); process.exit(1); }
const h = { 'x-pin': pin, 'content-type': 'application/json' };
let running = false;

async function tick() {
  if (running) return; // never overlap two polls: the same job would be fetched twice
  running = true;
  try {
    const res = await fetch(`${url}/api/print/next?mall=${mall}`, { headers: h });
    if (!res.ok) throw new Error('server said ' + res.status);
    const job = await res.json();
    if (job) {
      const out = path.join(hot, path.basename(job.code));
      fs.mkdirSync(out, { recursive: true });
      for (const f of job.files) {
        const r = await fetch(`${url}/api/print/file?code=${encodeURIComponent(job.code)}&file=${encodeURIComponent(f)}`, { headers: h });
        if (!r.ok) throw new Error(`could not fetch ${f}: ${r.status}`);
        fs.writeFileSync(path.join(out, path.basename(f)), Buffer.from(await r.arrayBuffer()));
      }
      fs.writeFileSync(path.join(out, 'order.json'), JSON.stringify(job.lines, null, 2));
      const done = await fetch(`${url}/api/print/done`, { method: 'POST', headers: h, body: JSON.stringify({ code: job.code }) });
      if (!done.ok) throw new Error('could not mark printed: ' + done.status);
      console.log('queued for print', job.code);
    }
  } catch (e) { console.error(e.message); }
  running = false;
}
setInterval(tick, 3000);
