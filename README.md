# Picture Me Please: Santa photo platform

Cloud web app for Santa photo sessions (Senegal, Côte d'Ivoire, Benin). Design: `docs/superpowers/specs/`, plan: `docs/superpowers/plans/`.

## Run
```bash
npm install
PINS='{"host":"1111","photographer":"2222","cashier":"3333","monitor":"4444","admin":"9999"}' node server/main.js
```
Env: `PINS` (required, one PIN per role), `PORT` (default 3000), `DATA_DIR` (default `./data`, holds `app.db` and `photos/`).

## Pages
`/book.html` (public), `/host.html?mall=1`, `/photographer.html?mall=1`, `/monitor.html?mall=1`, `/cashier.html?mall=1`, `/admin.html?mall=1`, `/dashboard.html` (admin PIN; KPIs filtered per country, default Senegal). Staff pages ask for their role's PIN (admin PIN works everywhere).

## Add a mall
On the admin page (`/admin.html`): add the mall, note its ID, then open pages with `?mall=<ID>`.
Add slots from the admin page (times are entered and shown in UTC).

## At the mall
- Photographer laptop: `node tools/uploader.js <cameraFolder> <serverUrl> <photographerPin> <mallId>`
- Print PC: `node tools/print-agent.js <serverUrl> <cashierPin> <mallId> <printerHotFolder> <DATA_DIR>/photos`

## Before launch
Final consent wording for children's photos (placeholder in use), real printer integration (hot-folder assumed), HTTPS in front of the server.

## Exports
Dashboard buttons download CSV (semicolon-separated with BOM, opens directly in French-locale Excel): all paid orders, or a per-day summary, for the chosen country and dates. Hours and days are UTC; the peak-hours chart shifts Benin by +1 hour.

## Tests
`npm test` (the UI test needs Playwright installed).
