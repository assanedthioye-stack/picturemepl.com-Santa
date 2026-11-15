# Picture Me Please — Booth (Phase 1)

Windows booth app: direct Canon tethering, family touch screen on the 2nd monitor, silent print routing, PIN login + RBAC.

```
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
pnpm --filter @pmp/booth-server dev:session   # DEV: a walk-in booking, a dispatched session, a paid 4x6 order line
```

Staff PINs are 4–6 digits; admins need a password of 10+ characters. 5 wrong tries lock the account for 15 minutes.

## Files on disk (`C:\PhotoBooth`, override with `PMP_ROOT`)

```
Data\booth.sqlite                 WAL, synchronous=FULL
Sessions\{SessionID}\IMG_0001.JPG full-res, untouched (+ .CR2 when RAW+JPEG)
Sessions\{SessionID}\previews\    1600 px watermarked previews (the only images served over HTTP)
Unassigned\                       shots taken while no session was armed
PrintSpool\                       temporary PDFs, deleted after printing
```

## Canon Rebel T7 (EOS 2000D)

- **Driver order:** EDSDK (`@brick-a-brack/napi-canon-cameras`, remote shutter, ~instant download), then **WIA** if the Canon module cannot load (camera keeps saving to SD; new files are copied every ~1.5 s; no remote shutter). Force one with `PMP_CAMERA_DRIVER=edsdk|wia` or the `cameras.driver` column.
- **Close Canon EOS Utility** and disable Windows AutoPlay for the camera: they grab the USB session and EDSDK then sees no camera.
- With EDSDK the camera is set to `SaveTo=Host`: nothing is written to the SD card. Quality defaults to RAW+L JPEG; set the `camera.quality` setting to `jpeg` to halve transfer time.
- Physical shutter presses are downloaded too. A shot with no armed session goes to `Unassigned\`.
- Licensing: the npm package bundles Canon's `EDSDK.dll`. Make sure your Canon SDK agreement covers redistributing it.

## Second monitor (family touch screen)

The kiosk window opens full-screen on the first non-primary display (`PMP_KIOSK_DISPLAY_ID` to pick one) and moves when screens are plugged/unplugged. It uses its own cookie partition and a per-boot token, so it can only see and "♥" the current family's previews.
**Touch calibration:** on Windows, map the touch input to the 2nd screen once (Control Panel → Tablet PC Settings → Setup), or taps land on the staff monitor.

## Printing

| Size | Printer (default match) |
|---|---|
| 4x6, 5x7 | name containing `DS620` (DNP DS620A) |
| 8x10, custom | name containing `PIXMA` |

Each job becomes a one-page PDF at the exact paper size (300 dpi, EXIF-rotated, centre-cropped) and goes to the Windows spooler through SumatraPDF (bundled with `pdf-to-printer`), with no dialog. Only lines of **paid** orders print, up to the paid quantity. A job interrupted mid-print is marked failed (never auto-reprinted).

DNP tip: add the DS620A twice in Windows with different default paper ("DNP DS620A" = 4x6, "DNP DS620A 5x7" = 5x7), then set `print.printer.5x7 = DNP DS620A 5x7` in `settings`. Optional `print.paper.<size>` passes a driver paper name. `GET /api/printers` shows what each size resolves to.

## Security notes

- The server listens on **127.0.0.1 only** until LAN TLS + device pairing land; there are no LAN devices in Phase 1.
- HttpOnly + SameSite=Strict cookies, JSON-only writes, argon2id PIN hashes, hash-chained audit log (`verifyAuditChain`).
