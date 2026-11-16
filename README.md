# Picture Me Please

Windows booth app: direct Canon tethering, family touch screen on the 2nd monitor, silent print routing, PIN login + RBAC.

```
apps/web           Public mobile site (Vite + Preact): booking, QR ticket, gallery
apps/cloud         Cloud API (Hono): runs as a Supabase Edge Function, or on Node for dev/tests
supabase/          Postgres migrations + the bundled edge function
apps/desktop       Electron shell + React UI (staff app and /kiosk)
apps/booth-server  Local API (runs in an Electron utilityProcess): camera, ingest, kiosk, print, auth
packages/db        Drizzle SQLite schema + migrations (packages/db/drizzle)
packages/shared    RBAC matrix, print routes, fr/en strings
```

## Run

```bash
pnpm install
pnpm test
pnpm dev              # builds, then opens Electron
pnpm dist:win         # NSIS installer in apps/desktop/release (build on Windows)
```

Without a camera (macOS/Linux dev, CI): `PMP_CAMERA_DRIVER=mock pnpm dev`. The mock renders a numbered JPEG per shutter press.

First accounts (Admin screens arrive in Phase 2):

```bash
pnpm --filter @pmp/booth-server user:add --name "Awa Diop" --role cashier --secret 4821
pnpm --filter @pmp/booth-server user:add --name "Fatou Sow" --role admin --secret "a-long-password"
pnpm --filter @pmp/booth-server dev:booking -- --code 482913   # DEV: a confirmed online appointment to check in at the Host
```

Staff PINs are 4–6 digits; admins need a password of 10+ characters. 5 wrong tries lock the account for 15 minutes.

## Storage

| Variable | Default | Holds | Put it on |
|---|---|---|---|
| `PMP_ROOT` | `C:\PhotoBooth` | `Data\booth.sqlite`, `PrintSpool\` | **internal disk only** (an unplugged drive can corrupt the database) |
| `PMP_PHOTOS_DIR` | same as `PMP_ROOT` | `Sessions\`, `Unassigned\`, `Incoming\` | internal disk (recommended) |
| `PMP_MIRROR_DIR` | off | a verified second copy of every original | external USB drive |

```
Sessions\{SessionID}\IMG_0001.JPG full-res, untouched (+ .CR2 when RAW+JPEG)
Sessions\{SessionID}\previews\    1600 px watermarked previews (the only images served over HTTP; not mirrored)
Unassigned\                       shots taken while no session was armed
```

**Backup drive setup (once):** create the folder yourself, e.g. `E:\PhotoBooth-Backup`, then:

```bat
setx PMP_MIRROR_DIR "E:\PhotoBooth-Backup"
```

Restart the app afterwards. Every original is copied right after download, read back and compared (SHA-256) before it counts as backed up.
- If the folder is missing (drive unplugged, different drive letter), shooting continues; the Photographer screen shows **"Disque de sauvegarde absent"** and a pending count. When the drive returns, missed files are copied on the next shot or within 60 s (shots from the last 48 h).
- The app never creates the backup root itself, so a wrong or missing drive can't silently receive files.
- The top bar shows free space; it turns red under 20 GB on either disk.

**Capacity (estimates for the T7's 24 MP):** JPEG-only (default) ≈ 7 MB/shot ≈ 28 GB per 100 families of 40 shots; RAW+JPEG ≈ 32 MB/shot ≈ 128 GB. Set the `camera.quality` setting to `raw+jpeg` only if you edit RAW files.

## Canon Rebel T7 (EOS 2000D)

- **Driver order:** EDSDK (`@brick-a-brack/napi-canon-cameras`, remote shutter, ~instant download), then **WIA** if the Canon module cannot load (camera keeps saving to SD; new files are copied every ~1.5 s; no remote shutter). Force one with `PMP_CAMERA_DRIVER=edsdk|wia` or the `cameras.driver` column.
- **Close Canon EOS Utility** and disable Windows AutoPlay for the camera: they grab the USB session and EDSDK then sees no camera.
- With EDSDK the camera is set to `SaveTo=Host`: nothing is written to the SD card. Quality defaults to Large Fine JPEG (`camera.quality` = `raw+jpeg` to also keep CR2).
- Physical shutter presses are downloaded too. A shot with no armed session goes to `Unassigned\`.
- Licensing: the npm package bundles Canon's `EDSDK.dll`. Make sure your Canon SDK agreement covers redistributing it.

## Second monitor (family touch screen)

The kiosk window opens full-screen on the first non-primary display (`PMP_KIOSK_DISPLAY_ID` to pick one) and moves when screens are plugged/unplugged. It uses its own cookie partition and a per-boot token, so it can only see and "♥" the current family's previews.
**Touch calibration:** on Windows, map the touch input to the 2nd screen once (Control Panel → Tablet PC Settings → Setup), or taps land on the staff monitor.

## Booth day (Phase 2)

1. **Host** (`Accueil`, booth PC or paired tablet): scan the family's QR code (camera) or type the 6-digit booking code; or register a walk-in (name, phone, country SN/BJ/CI). Appointments are queued **ahead of** walk-ins. The walk-in's 6-digit gallery PIN is shown **once**; give it to the family (SMS sending arrives with the cloud). **Envoyer au photographe** pops the family up on the Photographer screen.
2. **Photographer**: the family's name, session code and live photo count; **Terminer et envoyer en caisse** hands them to the cashier.
3. **Cashier** (`Caisse`): picking a family also shows their photos on the 2nd screen; ♥ picked by the family pre-select the digital photos. Packages with prints get one photo slot per print. Totals are VAT-inclusive XOF; 18 % VAT is extracted (`tax.vat_bp` setting).
   - **Cash** needs an open drawer (opening float). Every cash sale is logged as a drawer movement. Closing uses a blind count and shows expected vs counted.
   - **Mobile Money** (Wave, Orange Money, MTN MoMo): the customer pays the booth's merchant number on their phone and shows the receipt; the cashier types the transaction reference. A reference is accepted once. Automatic push/confirmation via CinetPay/FedaPay needs the cloud webhook (Phase 3).
   - Payment confirmed → print jobs go to the print router, purchased originals go to `upload_jobs` (drained by the Phase 3 uploader).

**Prices** come from the official list "Tarifs par pays", October 2026 (`apps/booth-server/src/pos/pricing.ts`). Each booth sells its own country's column, set once per PC:

```bat
setx PMP_COUNTRY "CI"
```

(`SN` default, `CI`, `BJ`; restart the app.) The country also picks the Mobile Money methods: Orange Money and Wave in Senegal and Côte d'Ivoire, MTN MoMo and Celtiis Cash in Benin. Cash is accepted everywhere.

| Formule | Contenu (as printed by the booth) | SN | CI | BJ |
|---|---|---|---|---|
| Essentiel | 1 × 13×18, 2 × 10×15, 4 portefeuilles, 1 fichier | 7 500 | 9 000 | 6 500 |
| Famille | 1 × 20×25, 2 × 13×18, 2 × 10×15, 8 portefeuilles, 1 fichier | 10 000 | 12 000 | 8 500 |
| Prestige | 2 × 20×25, 2 × 13×18, 4 × 10×15, 8 portefeuilles, tous les fichiers | 18 000 | 21 500 | 15 500 |
| Numérique | 1 fichier | 5 000 | 6 000 | 4 500 |
| Tirage 20×25 / 13×18 / 2 × 10×15 / 8 portefeuilles | à l'unité | 3 500 / 2 500 / 1 500 / 1 500 | 4 000 / 3 500 / 2 000 / 2 000 | 3 000 / 2 500 / 1 500 / 1 500 |

- **Wallets** ("format portefeuille", 6×9 cm) print 4 to a 13×18 sheet (2.5×3.5 in each) on the DNP, using the 13×18 queue/paper settings. 4 wallets = 1 sheet, 8 = 2 sheets. No cut marks: trim on the guillotine.
- Not sold at the booth: *Photo de classe* and *Mosaïque de classe* (school products).
- Prestige's *retouche premium* is done by hand outside the app; the background of choice ("sur le fond de votre choix") is not supported by the booth.
- On the first start after an update, the new price list replaces the old one; earlier packages stay in the database, inactive, so past orders keep their references.

## Tablets on the LAN

The booth PC serves the staff app to **paired** devices over HTTPS on port 4443 (browsers only allow the camera, needed for QR scanning, on HTTPS).

- On first start the booth creates its own certificate authority (`Data\tls\`). It is **name-constrained** to `*.local` and private IP ranges, so it can't be used to impersonate real websites.
- **Pairing** (supervisor or admin, on the booth PC): home screen → *Appairer une tablette*. Scan QR 1 on the tablet to install the certificate (once per tablet), then QR 2 (valid 5 minutes, single use). Staff then sign in with their PIN as usual. Lost tablet → *Retirer*.
- Plain HTTP from the LAN only serves `/setup` and `/ca.crt`. Every other LAN request needs HTTPS + a paired device; the booth PC itself (loopback) is always trusted.
- The installer opens TCP 4100/4443 on **private** networks only: set the booth Wi-Fi to *Private* in Windows. Give the PC a DHCP reservation; the server certificate follows the IPs seen at startup. If the PC boots before Wi-Fi is up, LAN access starts by itself once an address appears.
- `PMP_LAN=0` keeps everything on loopback.

## Printing

| Size | Printer (default match) |
|---|---|
| 4x6, 5x7 | name containing `DS620` (DNP DS620A) |
| 8x10, custom | name containing `PIXMA` |

Each job becomes a one-page PDF at the exact paper size (300 dpi, EXIF-rotated, centre-cropped) and goes to the Windows spooler through SumatraPDF (bundled with `pdf-to-printer`), with no dialog. Only lines of **paid** orders print, up to the paid quantity. A job interrupted mid-print is marked failed (never auto-reprinted). Failed jobs show as a red pill on the Cashier screen; **Relancer** sends them again once the printer is fixed.

DNP tip: add the DS620A twice in Windows with different default paper ("DNP DS620A" = 4x6, "DNP DS620A 5x7" = 5x7), then set `print.printer.5x7 = DNP DS620A 5x7` in `settings`. Optional `print.paper.<size>` passes a driver paper name. `GET /api/printers` shows what each size resolves to.

## Online: booking site, payments, gallery (Phase 3)

```
phone ── apps/web ──► cloud API (Supabase Edge Function + Postgres + Storage) ◄── booth sync (every 15 s)
                           ▲   ▲                                                 push changes, pull online
          CinetPay/FedaPay │   │ MTN MoMo                                        bookings, upload photos
              (SN, CI)     │   │ (BJ)
```

**Family, on the phone:**
1. Pick the country, the mall, the day and time, and the package (prices from the October 2026 list).
2. Enter name and phone, then pay. The time slot is held for 15 minutes while they pay.
   - **Senegal and Côte d'Ivoire:** Wave or Orange Money on the provider's payment page.
   - **Benin:** an MTN MoMo prompt on the phone.
3. Get the **ticket**: a high-contrast QR code, the 6-digit code, the gallery PIN, a downloadable PNG and a WhatsApp share link.
4. After the shoot, the same link becomes the **gallery**. The family enters the PIN to see watermarked previews, unlocks photos by Mobile Money (Numérique price per photo), then downloads or shares the HD files.

Photos included in the package the cashier sold are unlocked automatically. Walk-ins get a QR code to the same page from the Host screen.

**Payments**
- One adapter in `apps/cloud/src/payments/` covers CinetPay, FedaPay and MTN MoMo Collections.
- **Webhooks only trigger a fresh status check** with the provider; nothing is ever marked paid from a webhook body alone.
- **When a webhook is late:** the family's page and the cashier screen keep re-checking. The cashier also has **"Vérifier la transaction"**, which asks the provider directly and can compare the transaction ID from the customer's SMS.
- **Celtiis Cash has no API integration yet.** It's paid at the booth with manual entry.
- **The MTN merchant account:** with the Collections API, money goes to the account bound to the API user and key. `MTN_MERCHANT_MSISDN` (default `2290159089346`) is only shown for the manual fallback. Make sure the MTN credentials belong to that wallet.
- **Amounts that don't match are never accepted.** Payment statuses only move forward.

**Booth link to the cloud:** create the booth in the cloud (it prints the token once), then set three variables on the booth PC:

```bash
DATABASE_URL=postgres://… pnpm --filter @pmp/cloud seed -- --country SN --venue "…" --city Dakar --from 2026-12-01 --to 2026-12-31 --open 10:00 --close 20:00 --minutes 15 --capacity 1
```

```bat
setx PMP_CLOUD_URL "https://<project>.supabase.co/functions/v1"
setx PMP_BOOTH_ID "<printed id>"
setx PMP_CLOUD_TOKEN "<printed token>"
setx PMP_WEB_URL "https://<web site>"
```

- The booth pushes its sales and photos, pulls online bookings, and uploads gallery files:
  - **400 px thumbnails and 1024 px previews** (from the watermarked preview) when a shoot finishes;
  - **3000 px originals**: purchased photos first, then all of them.
- If the Host enters a code the booth doesn't know yet, it syncs immediately before saying "not found".
- A booth can only change its own rows. It can never mark a provider payment as paid, or change an online booking's code, PIN or slot.

**Deploy (Supabase)**

```bash
supabase db push
```

```bash
pnpm build:edge
```

```bash
supabase functions deploy api --no-verify-jwt
```

Create a private Storage bucket `photos`. Set these function secrets:
- `SUPABASE_DB_URL`, `PUBLIC_WEB_URL`, `API_PUBLIC_URL` (`https://<project>.supabase.co/functions/v1`), `GALLERY_SECRET` (long random);
- **CinetPay:** `CINETPAY_APIKEY`, `CINETPAY_SITE_ID`;
- **FedaPay:** `FEDAPAY_SECRET_KEY`, `FEDAPAY_ENV=live`;
- **MTN:** `MTN_SUBSCRIPTION_KEY`, `MTN_API_USER`, `MTN_API_KEY`, `MTN_BASE_URL=https://proxy.momoapi.mtn.com`, `MTN_TARGET_ENV=mtnbenin`;
- **Routing (optional):** `PROVIDER_SN` / `PROVIDER_CI` (`cinetpay` default, or `fedapay`).

Webhook URLs to register with each provider: `…/functions/v1/api/webhooks/cinetpay`, `…/fedapay`, `…/mtn`.

The site is static: `VITE_API_URL=https://<project>.supabase.co/functions/v1 pnpm build:web` and host `apps/web/dist` anywhere that serves `index.html` for unknown paths (`/b/…`).

**Local dev:** start a Postgres, then run each of these in its own terminal:

```bash
DATABASE_URL=postgres://pmp:pmp@127.0.0.1/pmp_dev pnpm dev:cloud
```

```bash
pnpm dev:web
```

`pnpm dev:cloud` accepts fake payments (approved instantly; a phone ending in 0000 is refused).

**Tests:** `pnpm test` needs a Postgres the tests can create throwaway databases on (`TEST_DATABASE_ADMIN_URL`, default `postgres://pmp:pmp@127.0.0.1/postgres`).

## Reliability rules (audit, November 2026)

What the system guarantees, and what staff will see:

- **Nobody pays twice.** Before the cashier takes cash, types a manual reference, starts another Mobile Money request or rebuilds the cart, the booth asks the cloud about any phone payment still pending for that family. If it went through, the order is closed as paid and the second payment is refused ("Cette commande vient d'être payée").
- **Money that arrives late is kept as credit.** A phone payment confirmed after the cart was replaced shows as *Prépayé en ligne* on the family; the next cart is reduced by that amount. There is no refund flow in the app.
- **Online orders belong to the cloud.** A cart built at the till never cancels a booking or gallery purchase being paid on a phone, and a booth can never change another booth's rows.
- **A lost network answer is not a lost payment.** The payment is recorded on the booth before the request leaves; if no answer comes back the cashier sees "Réponse du réseau perdue" while the booth finds out what happened.
- **Sync never gets stuck on one bad row,** and never skips an online booking made while another was being saved. Uploads retry for as long as the network is down. *Cloud hors ligne* appears on the Photographer screen when the cloud cannot be reached.
- **Queue:** a family marked *Parti* rejoins the queue when their code is scanned again; the same family cannot be queued twice.
- **Photos:** a photo that has been sold cannot be hidden. Photos that finish processing after the shoot is closed still reach the online gallery.
- **Public site limits:** 2 unpaid slot holds per phone number; the gallery locks after 5 wrong PINs in 15 minutes; payment pages stop checking after 5 minutes and say so.
- **Booth PC:** if the booth server crashes it restarts and the screens reload. If it cannot start at all (port in use, damaged disk), an error box appears after 5 tries instead of an empty screen.

Upgrading an existing cloud: `supabase db push` applies `20261116000000_sync_order.sql` (ordering lock for sync, attempt ids for the PIN limit). Deploy it before the new function.

`pnpm typecheck` also runs as the linter: unused code, missing returns, switch fall-through and implicit overrides fail the build.

## Security notes

- LAN: HTTPS + device pairing (above); pairing can only be started from the booth PC.
- HttpOnly + SameSite=Strict staff cookies (`Secure` over HTTPS), JSON-only writes, argon2id PIN hashes, hash-chained audit log (`verifyAuditChain`). Check-ins, walk-ins, dispatches, orders, payments, drawer open/close and device pairing are all audited.
