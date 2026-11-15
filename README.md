# Picture Me Please: Santa photo platform

Cloud web app for Santa photo sessions (Senegal, Côte d'Ivoire, Benin). Design: `docs/superpowers/specs/`, plan: `docs/superpowers/plans/`.

## Run
```bash
npm install
PINS='{"host":"1111","photographer":"2222","cashier":"3333","monitor":"4444","admin":"9999"}' node server/main.js
```
Env: `PINS` (required, one PIN per role), `PORT` (default 3000), `DATA_DIR` (default `./data`, holds `app.db` and `photos/`).

## Pages
`/` (public booking), `/host.html`, `/photographer.html`, `/monitor.html`, `/cashier.html`, `/admin.html`, `/dashboard.html`.
With several malls, each device asks which mall once and remembers it.

## PINs
- **Personal PINs:** every host, photographer, cashier (and extra admin) has their own 6-digit PIN, created on the admin page under "Personnel". It is shown once; reset or deactivate it there. Every action is credited to the PIN's owner.
- **Device PINs** (in the `PINS` setting): `admin` (master admin), `monitor` (customer screen), optional `printer` (print script). Shared PINs for host, photographer and cashier are ignored.
- PINs are stored only as keyed hashes; the key is in `DATA_DIR/pin.key`. Keep that file with the database when moving servers.

## Photo protection
- Every screen (customer monitor, cashier, host) receives only a small watermarked preview (1000 px, `PICTURE ME PLEASE` across the image).
- The clean original is released only to the admin, and to the printer PIN once payment is confirmed, and only for the photos the family chose.
- No staff PIN can copy or download a picture. When a family pays for a digital item, the cashier screen shows a QR code with a private link (`/get.html#…`, valid 30 days): the family downloads its own purchased photos on its own phone. The admin can also download any original from the admin page.
- A screenshot of the watermarked preview cannot be prevented by any website.

## Security notes
- `PINS` must hold different PINs of 4+ characters for `admin` and `monitor` (and `printer` if set); the server refuses to start otherwise.
- PINs travel in a request header only, never in a URL. 20 wrong PINs from one address lock that address out for 10 minutes.
- Run behind HTTPS (Hostinger provides it).

## Add a mall
On the admin page (`/admin.html`): add the mall, then create its time slots with the one-step form (local time).

## At the mall
- Photographer laptop: `node tools/uploader.js <cameraFolder> <serverUrl> <photographer's personal PIN> <mallId>`
- Print PC: `node tools/print-agent.js <serverUrl> <printerPin> <mallId> <printerHotFolder>` (downloads the clean photos of paid orders only)

## Before launch
Final consent wording for children's photos (placeholder in use), real printer integration (hot-folder assumed), HTTPS in front of the server.

## Exports
Dashboard buttons download CSV (semicolon-separated with BOM, opens directly in French-locale Excel): all paid orders, or a per-day summary, for the chosen country and dates. Days and hours are local to each mall (Benin is UTC+1).

## Tests
`npm test` (the UI tests need Playwright). Lint: see `eslint.config.js`.
