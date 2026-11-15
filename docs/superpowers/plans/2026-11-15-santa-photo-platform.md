# Santa Photo Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One cloud web app for Santa photo sessions: live booking calendar, host check-in and queue, photographer now-serving, monitor gallery and package picker, cashier payment that releases on-site printing, and admin.

**Architecture:** One Node.js process serving JSON APIs and plain HTML/JS pages (no framework, no build step). SQLite via built-in `node:sqlite`. Photos stored on disk and served by code. A small watcher script on the photographer laptop uploads shots; a small print-agent script at each mall polls for paid orders.

**Tech Stack:** Node 22 (built-in `node:http`, `node:sqlite`, `node:test`), the `qrcode` npm package (only dependency), vanilla HTML/JS front end.

**Spec:** `/home/user/docs/superpowers/specs/2026-11-15-santa-photo-platform-design.md`

## Global Constraints

- Countries and currency: Senegal (SN), Côte d'Ivoire (CI), Benin (BJ); all amounts in XOF, stored as integers.
- French is the default UI language, English is an option; mobile-first public pages.
- Prices per country come from the spec tables (Essentiel 7,500/9,000/6,500; Famille 10,000/12,000/8,500; Prestige 18,000/21,500/15,500; Numérique 5,000/6,000/4,500 for SN/CI/BJ; 8x10 3,500/4,000/3,000; 5x7 2,500/3,500/2,500; two 4x6 1,500/2,000/1,500; wallets 1,500/2,000/1,500). No class photo or composite.
- Package print sizes: Essentiel = 5x7, 4x6, wallet; Famille and Prestige = 8x10, 5x7, 4x6, wallet; Numérique = none.
- Discounts: 20% only when the order has 2+ packages (highest-priced package full price, all others 20% off; a second identical package qualifies); extra prints of a size an ordered package includes get 20% off, but only when a package is in the order; extra digital files never discounted; a single package never discounted.
- Payment: method Cash or Mobile Money; Mobile Money provider required (Orange Money or Wave for SN/CI; MTN MoMo or Celtiis Cash for BJ) plus a reference; cash records amount received. "Paid" is impossible without these. Printing only after Paid.
- Queue: appointments by slot time, then walk-ins by arrival. Check-in more than 30 minutes after slot start counts as a walk-in. Code stays valid.
- Consent tick-box required at booking and at walk-in check-in. Galleries are private by unguessable code; digital links expire 30 days after payment.
- Staff log in with a PIN per role and mall.
- No WhatsApp integration in v1.

## Review Focus

- Same code scanned twice at check-in: second scan must not create a second queue entry.
- Two families booking the last slot spot at once: only one succeeds, no overbooking.
- Photographer uploads shots while no family is active: shots are rejected with a clear error, never attached to the wrong family.
- Order total is recomputed on the server at Paid time; a tampered client total is ignored.
- Expired (30-day) or unknown gallery/download code returns a friendly 404 and leaks nothing about other families.

## File Structure

- `server/index.js`: HTTP router, static files, PIN auth middleware.
- `server/db.js`: schema creation and seed (malls, slots, prices).
- `server/pricing.js`: pure `priceOrder`.
- `server/booking.js`: slots, bookings, cancel.
- `server/queue.js`: check-in, queue order, serve next.
- `server/photos.js`: ingest and gallery access.
- `server/orders.js`: cart, payment, print queue.
- `server/admin.js`: malls, slots, prices, daily sales.
- `public/*.html`, `public/app.js`: one page per screen (book, host, photographer, monitor, cashier, admin).
- `tools/uploader.js` (photographer laptop), `tools/print-agent.js` (mall).
- `test/*.test.js`: one file per server module.

---

### Task 1: Project, database and pricing

**Files:**
- Create: `package.json`, `server/db.js`, `server/pricing.js`, `test/pricing.test.js`

**Interfaces:**
- Produces: `openDb(path: string): DatabaseSync` creating tables `malls(id,name,country)`, `slots(id,mall_id,start_at,capacity)`, `bookings(id,code,slot_id,name,phone,consent,status,created_at)`, `queue(id,booking_id,code,name,kind,checked_in_at,state)`, `photos(id,code,file,created_at)`, `orders(id,code,lines_json,total,method,provider,reference,amount_received,paid_at,cashier,print_state)`, `prices(country,item,amount)`.
- Produces: `priceOrder(country: 'SN'|'CI'|'BJ', items: {item: string, qty: number}[], prices: Record<string, number>): { lines: {item, qty, unit, discounted: boolean, amount}[], total: number }`. Item keys: `essentiel, famille, prestige, numerique, print_8x10, print_5x7, print_4x6, wallet, digital`.

- [ ] **Step 1: Write failing tests in `test/pricing.test.js`** with the SN price table and these assertions: Famille alone = 10000; two Essentiel = 7500 + 6000 = 13500; Essentiel + Prestige = 18000 + 6000 = 24000; Essentiel + Prestige + Famille = 18000 + 8000 + 6000; Famille + one extra `print_8x10` = 10000 + 2800; Essentiel + `print_8x10` = 7500 + 3500 (size not included); Famille + `digital` extra undiscounted; `print_8x10` alone (no package) = 3500; Numérique + `print_5x7` = 5000 + 2500.
- [ ] **Step 2: Run** `node --test test/pricing.test.js`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `priceOrder` in `server/pricing.js` and schema in `server/db.js`, seeding prices from the spec for all three countries.** Sort packages by price descending, first full price, rest 20% off; extra prints discounted only when some ordered package includes that size.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `git init` if needed, then `feat: schema and pricing rules`.

### Task 2: Booking calendar API

**Files:**
- Create: `server/booking.js`, `test/booking.test.js`

**Interfaces:**
- Consumes: `openDb` from Task 1.
- Produces: `listSlots(db, mallId, day: 'YYYY-MM-DD'): {id, start_at, capacity, remaining}[]`; `book(db, {slotId, name, phone, consent}): {code: string}` (throws `Error('full')` or `Error('consent')`; code is 8 chars from an unambiguous alphabet); `cancel(db, code): void` (frees the slot).

- [ ] **Step 1: Write failing tests:** remaining decreases after `book`; booking beyond capacity throws `full`; `consent: false` throws `consent`; `cancel` raises remaining again; codes are unique across 1,000 bookings. Overbooking test: capacity 1, two `book` calls in sequence, second throws (use a transaction, not read-then-write).
- [ ] **Step 2: Run** `node --test test/booking.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement the three functions** with `BEGIN IMMEDIATE` transactions for `book`.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: booking calendar`.

### Task 3: Check-in and queue

**Files:**
- Create: `server/queue.js`, `test/queue.test.js`

**Interfaces:**
- Consumes: `bookings`, `slots` tables.
- Produces: `checkIn(db, code, now: Date): {kind: 'appointment'|'walkin', position: number}` (idempotent: same code twice returns the existing entry); `addWalkIn(db, mallId, {name, phone, consent}, now): {code}` (consent required, throws `Error('consent')`); `getQueue(db, mallId): {code, name, kind, state}[]` ordered appointments by slot start then walk-ins by `checked_in_at`; `serveNext(db, mallId): {code, name} | null` sets `state='serving'` on the head and `done` on the previous.

- [ ] **Step 1: Write failing tests:** check-in at slot start +29 min is `appointment`; at +31 min is `walkin`; second `checkIn` with the same code returns same entry and queue length stays 1; two appointments and a walk-in who arrived first serve in order appointment, appointment, walk-in; `serveNext` on an empty queue returns `null`; walk-in without consent throws; unknown code throws `Error('unknown code')`.
- [ ] **Step 2: Run** `node --test test/queue.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement the four functions.**
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: check-in and queue`.

### Task 4: Photos and gallery

**Files:**
- Create: `server/photos.js`, `test/photos.test.js`, `tools/uploader.js`

**Interfaces:**
- Consumes: `queue` table (active family = row with `state='serving'` for the mall).
- Produces: `ingest(db, dir, mallId, filename, bytes: Buffer): {code}` (throws `Error('no active family')`; stores under `dir/<code>/`); `gallery(db, code): string[] | null` (file names, `null` if unknown); `tools/uploader.js <watchDir> <serverUrl> <pin>` watches a folder with `fs.watch` and POSTs each new JPEG to `/api/photos`.

- [ ] **Step 1: Write failing tests:** with a serving family `ingest` stores a file and `gallery` lists it; with nobody serving it throws `no active family`; after `serveNext` moves to the next family, new shots attach to the new code only; `gallery('NOPE')` returns `null`.
- [ ] **Step 2: Run** `node --test test/photos.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement `ingest` and `gallery`; write the uploader script** (retry once on network failure, log rejected files).
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: photo ingest and gallery`.

### Task 5: Orders, payment and print queue

**Files:**
- Create: `server/orders.js`, `test/orders.test.js`, `tools/print-agent.js`

**Interfaces:**
- Consumes: `priceOrder` (Task 1), `gallery` (Task 4).
- Produces: `saveCart(db, code, items, photoFiles: string[]): void`; `pay(db, code, {method, provider, reference, amountReceived, cashier}, now): {total}` (server recomputes total from saved cart; throws `Error('invalid payment')` for missing provider or reference on Mobile Money, a provider not allowed in the mall's country, or cash `amountReceived` below total; sets `print_state='ready'` and a `download_expires_at` 30 days out); `nextPrintJob(db, mallId): {code, lines, files} | null`; `markPrinted(db, code): void`; `download(db, code, now): string[] | null` (`null` after expiry or if unpaid).
- Produces: `tools/print-agent.js <serverUrl> <pin> <hotFolder>` polling `nextPrintJob` and copying files to the printer hot folder, then calling `markPrinted`.

- [ ] **Step 1: Write failing tests:** unpaid order is absent from `nextPrintJob`; after valid `pay` it appears; Mobile Money without reference throws; Orange Money in a BJ mall throws; Celtiis Cash in BJ succeeds; cash amount below total throws; tampered client total is ignored (total equals `priceOrder` result); `download` returns files at day 29 and `null` at day 31; `markPrinted` removes it from the queue.
- [ ] **Step 2: Run** `node --test test/orders.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement the functions and the print agent.**
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: orders payment and printing`.

### Task 6: HTTP server, PIN auth and admin

**Files:**
- Create: `server/index.js`, `server/admin.js`, `test/api.test.js`

**Interfaces:**
- Consumes: all server modules.
- Produces: routes `GET /api/slots`, `POST /api/book`, `POST /api/cancel`, `POST /api/checkin`, `POST /api/walkin`, `GET /api/queue`, `POST /api/next`, `POST /api/photos`, `GET /api/gallery/:code`, `POST /api/cart`, `POST /api/pay`, `GET /api/print/next`, `POST /api/print/done`, `GET /api/download/:code`, admin `GET/PUT /api/admin/prices`, `POST /api/admin/slots`, `GET /api/admin/sales?day=`. PINs from env `PINS` JSON (`{"host":"..","photographer":"..","cashier":"..","admin":".."}`); staff routes return 401 without the right PIN header. `dailySales(db, mallId, day): {total, byMethod, byProvider}`.

- [ ] **Step 1: Write failing tests** booting the server on a random port: staff route without PIN is 401; wrong role PIN is 401; public booking works; end-to-end: book, check in, serve, upload, save cart, pay, print job appears; `dailySales` totals match two payments.
- [ ] **Step 2: Run** `node --test test/api.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement the router and `admin.js`.**
- [ ] **Step 4: Run all tests** `node --test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: http api and admin`.

### Task 7: Screens

**Files:**
- Create: `public/book.html`, `public/host.html`, `public/photographer.html`, `public/monitor.html`, `public/cashier.html`, `public/admin.html`, `public/app.js`, `public/i18n.js`

**Interfaces:**
- Consumes: Task 6 routes.
- Produces: book page (mall, day, live slots, name, phone, consent tick-box, shows code and QR via `qrcode`, French default and English switch, cancel by code); host (scan QR with `BarcodeDetector` or type code, walk-in form with consent, queue list, "Serve next"); photographer (name of family now serving, shot counter); monitor (gallery thumbnails, tap to select, package and extras picker, live total from `/api/cart` response); cashier (method, provider list filtered by country, reference or amount received, discounted lines shown, "Paid" disabled until fields valid); admin (slots, prices, daily sales).

- [ ] **Step 1: Write a Playwright smoke test `test/ui.test.js`** that books a slot on the phone-sized book page in French, checks in on the host page, serves, uploads a file through the API, picks Famille on the monitor, and pays cash on the cashier page; asserts the print job appears.
- [ ] **Step 2: Run it.** Expected: FAIL (pages missing).
- [ ] **Step 3: Build the pages** as plain HTML with a shared `app.js` fetch helper and `i18n.js` French/English strings.
- [ ] **Step 4: Run the smoke test and take phone-width screenshots of book and monitor pages for review.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: staff and family screens`.

### Task 8: Deployment notes

**Files:**
- Create: `README.md`

- [ ] **Step 1: Document** env vars (`PINS`, `PORT`, `DATA_DIR`), how to run (`node server/index.js`), how to run the uploader and print agent, how to seed malls, and the open pre-launch items from the spec (final consent wording, WhatsApp later).
- [ ] **Step 2: Commit** `docs: run and deploy`.

## Self-Review

- Spec coverage: booking calendar (Task 2), grace period and walk-ins (Task 3), photo tagging by code (Task 4), payment method and provider (Task 5), discounts (Task 1), 30-day links (Task 5), consent (Tasks 2, 3, 7), PIN roles and admin sales (Task 6), screens (Task 7). Gap: SMS/WhatsApp sending is intentionally out of scope.
- Type consistency: `code` is the family key everywhere; item keys are defined in Task 1 and reused in Tasks 5 and 7.
