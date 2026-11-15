# Picture Me Please: Santa Photo Platform, Design

## Intent
Run Santa photo sessions in malls in Senegal, Benin and Côte d'Ivoire with one very easy platform. Families book ahead (web or WhatsApp) or walk in. On the day a host checks them in, a photographer shoots tethered, and the family chooses photos and a package on a monitor. Printing happens on site, only after payment is confirmed (cash or Mobile Money) at the monitor.

## Goals
- Extremely simple for families (phone, French first, English option) and for non-technical mall staff.
- No wrong-family photo mix-ups: every photo is tied to a family code.
- Print is released only after the cashier confirms payment.
- Walk-ins are served after all appointments.

## Non-goals (v1)
- Online payment or deposits at booking.
- Automatic Mobile Money confirmation via API (cashier confirms manually).
- WhatsApp booking (replaced by a dynamic booking calendar; confirmations are shown on screen and sent as a shareable link, SMS/WhatsApp message sending is not in v1).
- Offline mode, and per-mall local servers.
- Photo editing, retouching, or shipping prints.

## Anti-goals
- A print leaving the printer before payment is confirmed.
- One family seeing another family's photos.
- Staff needing training beyond a minute or two.

## Constraints
- Countries: Senegal, Benin, Côte d'Ivoire. Currency XOF (CFA franc). French default, English option.
- Mobile-first for families; staff screens run on a laptop or tablet in a browser.
- Tethered shooting means large files uploaded from the photographer's laptop, so the mall needs decent internet.
- Booking uses a dynamic calendar on the web (live slot availability per mall, per day), so no Meta WhatsApp approval is needed. The booking page can be shared as a link on WhatsApp.
- The photos are mostly of children: consent and retention need to be handled (see Open items).

## Approaches considered
- **A. One cloud web app (chosen by the user).** All roles are browser screens, WhatsApp via Cloud API, a watcher script on the photographer's laptop uploads shots, cashier taps "Paid" to release printing. Fastest to build and update across three countries; needs reliable mall internet.
- B. A local server per mall synced to the cloud. Survives outages but costs an install and maintenance burden in every mall.
- C. Cloud app with a browser offline mode. More robust than A, but offline sync is the most complex part.
Upgrade path: if a mall's internet proves unreliable, move toward B or C.

## Flow
1. **Book:** the family picks a mall and a slot on the web or in WhatsApp, and gets a confirmation with a unique code and a QR code (also sent by WhatsApp or SMS).
2. **Check in (host screen):** the host scans the QR or types the code. Walk-ins are added with a name and phone number. Queue order is appointments by slot time, then walk-ins by arrival time.
3. **Photographer screen:** shows the family being served now (the host sets "next"). The watcher script on the photographer's laptop uploads each new shot to the active family's gallery.
4. **Monitor (customer screen):** shows the active family's gallery. The family selects photos and a package.
5. **Cashier confirmation:** the cashier records cash or Mobile Money (with a reference) and taps "Paid".
6. **Print:** only after "Paid", the order goes to the mall's print queue, and the print is handed over.

## Screens
Public booking page, WhatsApp booking flow, host check-in and queue, photographer now-serving, monitor gallery and package picker, cashier payment and print queue, and admin (malls, slots, packages and prices, daily sales).

## Decisions (user's)
Cloud web app (A). Payment at the monitor as a point-of-sale step. Printing on site, triggered only on confirmed payment. Appointments before walk-ins.

## Packages and prices (from "Pricing by Country", Oct 2026, per child, XOF)
Prices are stored per country and editable in admin.

| Package | Contents | Senegal | Côte d'Ivoire | Benin |
|---|---|---|---|---|
| Essentiel | 5x7, two 4x6, 4 wallets, 1 digital | 7,500 | 9,000 | 6,500 |
| Famille | 8x10, two 5x7, two 4x6, 8 wallets, 1 hi-res digital | 10,000 | 12,000 | 8,500 |
| Prestige | two 8x10, two 5x7, four 4x6, 8 wallets, all digital, premium retouching | 18,000 | 21,500 | 15,500 |
| Numérique | 1 chosen photo, hi-res digital | 5,000 | 6,000 | 4,500 |

Individual items (SN / CI / BJ): 8x10 print 3,500 / 4,000 / 3,000; 5x7 print 2,500 / 3,500 / 2,500; two 4x6 1,500 / 2,000 / 1,500; wallet (8) 1,500 / 2,000 / 1,500. Class photo and class composite are school-only and are not offered in the Santa flow.
Mobile Money per country: Orange Money or Wave (Senegal, Côte d'Ivoire); MTN MoMo or Celtiis Cash (Benin), plus cash, as decided.
Digital files: download link valid 30 days after payment.
Source note: the sheet is the school-photo price list; it is used as the Santa price list until told otherwise.

## À la carte rule (decided by the user)
- À la carte extras are allowed on top of a package.
- An extra print of a size the chosen package already includes gets 20% off its individual price. Example: Famille includes an 8x10, so an extra 8x10 is 2,800 F instead of 3,500 F in Senegal.
- A size the package does not include, and any extra digital file, stays full price.
- Which sizes each package includes: Essentiel = 5x7, 4x6, wallet. Famille and Prestige = 8x10, 5x7, 4x6, wallet. Numérique (digital only) includes no print sizes, so no discount applies.
- Package rule (decided by the user): the discount only applies when an order has two or more packages. A second identical package (e.g. a second Essentiel) gets 20% off. With two different packages (e.g. Essentiel + Prestige), only the lower-priced package gets 20% off. A single package never gets a discount. Calls I made for 3+ packages: the highest-priced package is full price and every other package gets 20% off.
- The discount on individual items applies only when a package is in the order (my call: a purely à la carte order pays full price, ask if wrong).
- The cashier screen calculates this automatically and shows the discounted line, so staff never work it out by hand.

## Booking calendar, no-shows and cancellations
- Dynamic calendar: the family picks a mall, a day and a slot; slots show live availability and capacity per slot (set in admin). Booking returns a unique code and QR.
- Grace period: a family checking in up to 30 minutes after their slot keeps their appointment priority. After 30 minutes they are treated as a walk-in (served after on-time appointments, by arrival time). The code stays valid; nothing is charged for a missed slot.
- Cancelling or rebooking releases the slot immediately.

## Calls I made (change any)
- Stack: a single Node.js app with a SQLite or Postgres database and a plain responsive front end; hosted on one cloud server.
- Mobile Money is confirmed manually with a reference number entered by the cashier.
- Photo-to-family linking uses the active session set by the host.
- Placeholder packages and prices, editable in admin.
- Staff log in with a simple PIN per role and mall.
- Gallery access is only through a short, unguessable code or link.

## Left to the builder
Exact UI, database schema, print integration (watched print folder or the printer's own software), image resizing for fast monitor display, and the WhatsApp message wording.

## Open items for the user (needed before launch, not before building)
- Consent and retention for children's photos: the user pointed to www.picturemepls.com, which could not be fetched from this session (blocked/unreachable). Until the wording is supplied, the build uses: parent ticks a consent box at booking and at walk-in check-in, galleries are private by code, digital links expire after 30 days. Confirm or paste the real policy.
- None. Decided by the user: Santa sessions use the same price list, accept cash, and print on site. The consent placeholder above is approved for v1.

## Payment recording (cashier screen)
Every order must record, before "Paid" can be tapped:
- **Payment method:** Cash or Mobile Money.
- **Payment type (Mobile Money provider):** Orange Money or Wave (Senegal, Côte d'Ivoire); MTN MoMo or Celtiis Cash (Benin). Only the providers for the mall's country are offered. Required when the method is Mobile Money.
- **Reference number:** required for Mobile Money; for cash, the amount received.
Method, type, reference, amount, cashier and time are saved on the order and shown in the admin daily sales report.
