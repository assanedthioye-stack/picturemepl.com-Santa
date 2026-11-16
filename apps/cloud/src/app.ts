import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { z, ZodError } from 'zod';
import { COUNTRIES, normalizePhone, ONLINE_CODES, packageId, PRICE_LIST, type Country } from '@pmp/shared';
import type { Db } from './db';
import { PayError, refreshPayment, refreshPendingOf, startPayment, type PaymentsConfig } from './payments/service';
import type { Method } from './payments/types';
import { hashPin, verifyPin } from './pin';
import type { Storage } from './storage';
import { applyBoothRow, applyBoothRowSafely, pullForBooth } from './sync';
import { newId, randomDigits, randomToken, sha256Hex, signToken, verifyToken } from './util';

export interface CloudDeps {
  db: Db;
  storage: Storage & { handle?(req: Request): Promise<Response> };
  payments: PaymentsConfig;
  /** Public web app origin, e.g. https://picturemepls.com — used for return URLs. */
  webUrl: string;
  /** HMAC secret for gallery sessions. */
  secret: string;
}

const HOLD_MS = 15 * 60_000;
const MAX_HOLDS_PER_PHONE = 2;
const MAX_PIN_FAILS = 5;
const VAT_BP = 1800; // 18 % in SN, BJ and CI
const MOMO = ['wave', 'orange_money', 'mtn_momo', 'celtiis_cash'] as const;
const LIVE = `('confirmed','checked_in','in_session','shot_complete','completed')`;
const vatOf = (ttc: number) => Math.round((ttc * VAT_BP) / (10_000 + VAT_BP));
const priceOf = (code: string, country: Country) => PRICE_LIST.find((p) => p.code === code)?.price[country];

const NewBooking = z.object({
  slotId: z.string().min(1),
  packageCode: z.string().refine((c) => ONLINE_CODES.includes(c), 'unknown_package'),
  fullName: z.string().trim().min(2).max(80),
  phone: z.string().min(6).max(25),
  phoneCountry: z.enum(['SN', 'BJ', 'CI']),
  partySize: z.number().int().min(1).max(20).default(1),
  locale: z.enum(['fr', 'en']).default('fr'),
});
const Pay = z.object({ method: z.enum(MOMO), phone: z.string().max(25).optional(), phoneCountry: z.enum(['SN', 'BJ', 'CI']).optional() });
const Buy = Pay.extend({ photoIds: z.array(z.string()).min(1).max(200) });
const Push = z.object({ rows: z.array(z.object({ tbl: z.string(), row: z.record(z.string(), z.unknown()) })).max(500) });

export function createCloudApp(d: CloudDeps): Hono {
  const { db } = d;
  const app = new Hono();
  // Providers send the customer back here (CinetPay with a POST, which static web hosts refuse), then on to the site.
  const returnTo = (pathOnWeb: string) => `${d.payments.apiUrl}/api/return?to=${encodeURIComponent(d.webUrl + pathOnWeb)}`;

  app.onError((err, c) => {
    if (err instanceof PayError) return c.json({ error: err.message }, err.status as 400);
    if (err instanceof ZodError) return c.json({ error: 'invalid', issues: err.issues }, 400);
    if (err instanceof SyntaxError) return c.json({ error: 'invalid_json' }, 400); // malformed request body
    console.error(err);
    return c.json({ error: 'internal' }, 500);
  });
  // Public JSON API: no cookies, so any origin may call it.
  app.use('/api/*', cors({ origin: '*', allowHeaders: ['content-type', 'authorization'] }));
  if (d.storage.handle) app.all('/dev-storage/*', (c) => d.storage.handle!(c.req.raw));

  // ─── public: booking flow ───
  app.all('/api/return', (c) => {
    const to = c.req.query('to') ?? '';
    // Only our own site: never an open redirect.
    return c.redirect(to.startsWith(`${d.webUrl}/`) ? to : `${d.webUrl}/`, 303);
  });

  app.get('/api/venues', async (c) => {
    const country = z.enum(['SN', 'BJ', 'CI']).parse(c.req.query('country'));
    return c.json(await db.query(
      `select v.id as "venueId", v.name, v.city, v.country, e.id as "eventId", e.name_fr as "eventFr", e.name_en as "eventEn",
              to_char(e.starts_on, 'YYYY-MM-DD') as "startsOn", to_char(e.ends_on, 'YYYY-MM-DD') as "endsOn"
       from venues v join events e on e.venue_id = v.id
       where v.country = $1 and v.active and e.status in ('published', 'live') and e.ends_on >= current_date
       order by v.city, v.name`, [country]));
  });

  app.get('/api/slots', async (c) => {
    const eventId = z.string().min(1).parse(c.req.query('eventId'));
    const [y, m, day] = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(c.req.query('date')).split('-').map(Number) as [number, number, number];
    const [ev] = await db.query<{ country: Country }>('select v.country from events e join venues v on v.id = e.venue_id where e.id = $1', [eventId]);
    if (!ev) throw new PayError(404, 'event_not_found');
    const start = Date.UTC(y, m - 1, day) - COUNTRIES[ev.country].utcOffsetMin * 60_000; // local midnight
    const now = Date.now();
    const rows = await db.query<{ id: string; starts_at: number; ends_at: number; capacity: number; taken: number }>(
      `select s.id, s.starts_at, s.ends_at, s.capacity,
              (select count(*) from bookings b where b.slot_id = s.id
                and (b.status in ${LIVE} or (b.status = 'pending_payment' and b.hold_expires_at > $4))) as taken
       from time_slots s join booths bo on bo.id = s.booth_id
       where bo.event_id = $1 and s.starts_at >= $2 and s.starts_at < $3 and s.starts_at > $5
       order by s.starts_at`, [eventId, start, start + 86_400_000, now, now + 15 * 60_000]); // no booking in the last 15 minutes before a slot
    return c.json(rows.map((r) => ({ id: r.id, startsAt: r.starts_at, endsAt: r.ends_at, available: Math.max(0, r.capacity - r.taken) })));
  });

  app.get('/api/packages', (c) => {
    const country = z.enum(['SN', 'BJ', 'CI']).parse(c.req.query('country'));
    return c.json(PRICE_LIST.filter((p) => ONLINE_CODES.includes(p.code)).map((p) => ({
      id: packageId(p.code, country), code: p.code, nameFr: p.nameFr, nameEn: p.nameEn,
      priceXof: p.price[country], digitalsIncluded: p.digitalsIncluded, prints: p.prints,
    })));
  });

  app.post('/api/bookings', async (c) => {
    const b = NewBooking.parse(await c.req.json());
    const phone = normalizePhone(b.phoneCountry, b.phone);
    if (!phone) throw new PayError(400, 'invalid_phone');
    const now = Date.now();
    // One phone cannot sit on many unpaid slots (each hold blocks a place for 15 minutes).
    const [{ holds }] = await db.query<{ holds: number }>(
      `select count(*) as holds from bookings b join customers c on c.id = b.customer_id
       where c.phone = $1 and b.status = 'pending_payment' and b.hold_expires_at > $2`, [phone, now]) as [{ holds: number }];
    if (holds >= MAX_HOLDS_PER_PHONE) throw new PayError(429, 'too_many_pending');
    const pin = randomDigits(6);
    const pinHash = await hashPin(pin);
    const out = await db.tx(async (t) => {
      // Lock the slot row: two families can never take the last place at the same time.
      const [slot] = await t.query<{ id: string; booth_id: string; event_id: string; country: Country; capacity: number; starts_at: number }>(
        `select s.id, s.booth_id, bo.event_id, v.country, s.capacity, s.starts_at
         from time_slots s join booths bo on bo.id = s.booth_id join events e on e.id = bo.event_id join venues v on v.id = e.venue_id
         where s.id = $1 and v.active and e.status in ('published', 'live') for update of s`, [b.slotId]);
      if (!slot) throw new PayError(404, 'slot_not_found');
      if (slot.starts_at < now) throw new PayError(409, 'slot_past');
      const [{ taken }] = await t.query<{ taken: number }>(
        `select count(*) as taken from bookings where slot_id = $1 and (status in ${LIVE} or (status = 'pending_payment' and hold_expires_at > $2))`,
        [slot.id, now]) as [{ taken: number }];
      if (taken >= slot.capacity) throw new PayError(409, 'slot_full');
      const price = priceOf(b.packageCode, slot.country)!;

      let code = '';
      for (;;) { // online codes: 6 digits, never starting with 9 (the booth's walk-in range), unique per booth
        code = String(1 + Number(randomDigits(1)) % 8) + randomDigits(5);
        if (!(await t.query('select 1 from bookings where booth_id = $1 and code = $2', [slot.booth_id, code])).length) break;
      }
      const customerId = newId(), bookingId = newId(), orderId = newId(), token = randomToken(16);
      await t.query(`insert into customers (id, phone, country, full_name, locale, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$6)`,
        [customerId, phone, b.phoneCountry, b.fullName, b.locale, now]);
      await t.query(
        `insert into bookings (id, code, public_token, pin_hash, event_id, booth_id, slot_id, customer_id, package_id, source, status, party_size, hold_expires_at, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'online','pending_payment',$10,$11,$12,$12)`,
        [bookingId, code, token, pinHash, slot.event_id, slot.booth_id, slot.id, customerId, packageId(b.packageCode, slot.country), b.partySize, now + HOLD_MS, now]);
      await t.query(
        `insert into orders (id, booking_id, booth_id, channel, status, subtotal_xof, total_xof, vat_bp, vat_xof, created_at, updated_at)
         values ($1,$2,$3,'online','open',$4,$4,$5,$6,$7,$7)`, [orderId, bookingId, slot.booth_id, price, VAT_BP, vatOf(price), now]);
      await t.query(
        `insert into order_items (id, order_id, package_id, kind, qty, unit_price_xof, line_total_xof, created_at, updated_at)
         values ($1,$2,$3,'bundle',1,$4,$4,$5,$5)`, [newId(), orderId, packageId(b.packageCode, slot.country), price, now]);
      return { token, code, amountXof: price, holdExpiresAt: now + HOLD_MS };
    });
    // The PIN is returned once (shown on the ticket); only its hash is stored.
    return c.json({ ...out, pin }, 201);
  });

  /** Ticket + gallery page data. Polling it also re-checks a pending payment (covers late webhooks). */
  app.get('/api/bookings/:token', async (c) => {
    const bk = await bookingByToken(db, c.req.param('token'));
    await refreshPendingOf(db, d.payments, { bookingId: bk.id });
    const [fresh] = await db.query<Record<string, any>>(
      `select b.status, b.code, b.package_id, b.party_size, c.full_name, s.starts_at, v.name as venue, v.city, v.country,
              (select o.total_xof from orders o where o.booking_id = b.id and o.channel = 'online'
                 and exists (select 1 from order_items i where i.order_id = o.id and i.kind = 'bundle') order by o.created_at limit 1) as amount,
              (select p.status from payments p join orders o on o.id = p.order_id where o.booking_id = b.id order by p.created_at desc limit 1) as payment_status,
              (select count(*) from photos p where p.booking_id = b.id and not p.hidden and p.preview_key is not null) as photo_count
       from bookings b join customers c on c.id = b.customer_id join booths bo on bo.id = b.booth_id
         join events e on e.id = bo.event_id join venues v on v.id = e.venue_id left join time_slots s on s.id = b.slot_id
       where b.id = $1`, [bk.id]);
    const f = fresh!;
    return c.json({
      status: f.status, code: f.status === 'pending_payment' ? null : f.code, familyName: f.full_name, partySize: f.party_size,
      venue: f.venue, city: f.city, country: f.country, startsAt: f.starts_at, packageId: f.package_id, amountXof: f.amount,
      paymentStatus: f.payment_status, photoCount: f.photo_count, photoPriceXof: priceOf('numerique', f.country),
    });
  });

  app.post('/api/bookings/:token/pay', async (c) => {
    const p = Pay.parse(await c.req.json());
    const bk = await bookingByToken(db, c.req.param('token'));
    if (bk.status !== 'pending_payment') throw new PayError(409, `booking_${bk.status}`);
    const now = Date.now();
    await db.tx(async (t) => {
      // Same lock as booking creation: re-taking an expired hold can never overbook the slot.
      const [slot] = await t.query<{ capacity: number }>('select capacity from time_slots where id = $1 for update', [bk.slot_id]);
      const [cur] = await t.query<{ status: string; hold_expires_at: number | null }>('select status, hold_expires_at from bookings where id = $1', [bk.id]);
      if (!slot || !cur) throw new PayError(404, 'slot_not_found');
      if (cur.status !== 'pending_payment') throw new PayError(409, `booking_${cur.status}`);
      if (!cur.hold_expires_at || cur.hold_expires_at < now) {
        const [{ taken }] = await t.query<{ taken: number }>(
          `select count(*) as taken from bookings x where x.slot_id = $1 and x.id <> $2
             and (x.status in ${LIVE} or (x.status = 'pending_payment' and x.hold_expires_at > $3))`, [bk.slot_id, bk.id, now]) as [{ taken: number }];
        if (taken >= slot.capacity) throw new PayError(409, 'slot_full');
      }
      // Paying takes a few minutes on a phone: the hold restarts so the place is not sold meanwhile.
      await t.query('update bookings set hold_expires_at = $2, updated_at = $3 where id = $1', [bk.id, now + HOLD_MS, now]);
    });
    const [order] = await db.query<{ id: string }>(
      `select o.id from orders o where o.booking_id = $1 and o.status = 'open' and exists (select 1 from order_items i where i.order_id = o.id and i.kind = 'bundle')`, [bk.id]);
    if (!order) throw new PayError(409, 'order_not_open');
    const r = await startPayment(db, d.payments, {
      orderId: order.id, method: p.method as Method, country: bk.country, phone: phoneFor(p, bk.country) ?? bk.phone,
      customerName: bk.full_name ?? undefined, description: 'Picture Me Please - reservation',
      returnUrl: returnTo(`/b/${c.req.param('token')}?paid=1`),
    });
    return c.json(r.kind === 'redirect' ? { kind: 'redirect', url: r.url, paymentId: r.paymentId } : { kind: 'push', paymentId: r.paymentId });
  });

  // ─── public: gallery ───
  app.post('/api/gallery/:token/login', async (c) => {
    const { pin } = z.object({ pin: z.string().regex(/^\d{6}$/) }).parse(await c.req.json());
    const bk = await bookingByToken(db, c.req.param('token'));
    const now = Date.now();
    // Record the attempt BEFORE checking the PIN: parallel guesses all count, so the limit cannot be raced.
    const attemptId = newId();
    await db.query('insert into gallery_attempts (id, booking_id, at, ok) values ($1, $2, $3, false)', [attemptId, bk.id, now]);
    const [{ fails }] = await db.query<{ fails: number }>(
      'select count(*) as fails from gallery_attempts where booking_id = $1 and not ok and at > $2', [bk.id, now - 15 * 60_000]) as [{ fails: number }];
    if (fails > MAX_PIN_FAILS) throw new PayError(429, 'too_many_attempts');
    if (!(await verifyPin(pin, bk.pin_hash))) throw new PayError(401, 'wrong_pin');
    await db.query('update gallery_attempts set ok = true where id = $1', [attemptId]);
    return c.json({ session: await signToken(d.secret, `g:${bk.id}`, 2 * 3600) });
  });

  app.get('/api/gallery/:token/photos', async (c) => {
    const bk = await galleryAuth(c, d);
    const photos = await db.query<{ id: string; seq: number; thumb_key: string | null; preview_key: string; deliverable_key: string | null }>(
      'select id, seq, thumb_key, preview_key, deliverable_key from photos where booking_id = $1 and not hidden and preview_key is not null order by taken_at, seq', [bk.id]);
    const unlocked = await entitledPhotoIds(db, bk.id);
    const keys = photos.flatMap((p) => [p.thumb_key ?? p.preview_key, p.preview_key, ...(unlocked.has(p.id) && p.deliverable_key ? [p.deliverable_key] : [])]);
    const urls = await d.storage.signDownloads([...new Set(keys)], 3600);
    return c.json({
      unitPriceXof: priceOf('numerique', bk.country),
      photos: photos.map((p) => ({
        id: p.id, seq: p.seq, thumbUrl: urls[p.thumb_key ?? p.preview_key], previewUrl: urls[p.preview_key],
        unlocked: unlocked.has(p.id), downloadUrl: unlocked.has(p.id) && p.deliverable_key ? urls[p.deliverable_key] : null,
      })),
    });
  });

  app.post('/api/gallery/:token/buy', async (c) => {
    const bk = await galleryAuth(c, d);
    const p = Buy.parse(await c.req.json());
    const ids = [...new Set(p.photoIds)];
    const owned = new Set((await db.query<{ id: string }>('select id from photos where booking_id = $1 and not hidden and id = any($2)', [bk.id, ids])).map((r) => r.id));
    if (owned.size !== ids.length) throw new PayError(400, 'photo_not_in_booking');
    // A purchase made a moment ago may not be confirmed yet: ask the provider before selling the same photos again.
    await refreshPendingOf(db, d.payments, { bookingId: bk.id }, { force: true });
    const unlocked = await entitledPhotoIds(db, bk.id);
    if (ids.some((id) => unlocked.has(id))) throw new PayError(409, 'already_unlocked');
    const unit = priceOf('numerique', bk.country)!;
    const total = unit * ids.length;
    const now = Date.now(), orderId = newId();
    await db.tx(async (t) => {
      await t.query(
        `insert into orders (id, booking_id, booth_id, channel, status, subtotal_xof, total_xof, vat_bp, vat_xof, created_at, updated_at)
         values ($1,$2,$3,'online','open',$4,$4,$5,$6,$7,$7)`, [orderId, bk.id, bk.booth_id, total, VAT_BP, vatOf(total), now]);
      for (const photoId of ids) {
        await t.query(
          `insert into order_items (id, order_id, package_id, photo_id, kind, qty, unit_price_xof, line_total_xof, created_at, updated_at)
           values ($1,$2,$3,$4,'digital',1,$5,$5,$6,$6)`, [newId(), orderId, packageId('numerique', bk.country), photoId, unit, now]);
      }
    });
    const r = await startPayment(db, d.payments, {
      orderId, method: p.method as Method, country: bk.country, phone: phoneFor(p, bk.country) ?? bk.phone,
      customerName: bk.full_name ?? undefined, description: `Picture Me Please - ${ids.length} photo(s)`,
      returnUrl: returnTo(`/b/${c.req.param('token')}?paid=1`),
    });
    return c.json({ ...(r.kind === 'redirect' ? { kind: 'redirect', url: r.url } : { kind: 'push' }), paymentId: r.paymentId, totalXof: total });
  });

  // ─── provider webhooks: hints only, the provider is always re-asked ───
  const hint = async (paymentId: string | undefined) => {
    if (paymentId) await refreshPayment(db, d.payments, paymentId, { force: true }).catch((e) => console.error('webhook refresh', paymentId, e));
  };
  app.get('/api/webhooks/cinetpay', (c) => c.text('ok')); // CinetPay pings the URL
  app.post('/api/webhooks/cinetpay', async (c) => {
    const ct = c.req.header('content-type') ?? '';
    // Providers retry on anything but 200: an unreadable body is answered "ok" and ignored.
    const body = await (ct.includes('json') ? c.req.json() : c.req.formData().then((f) => Object.fromEntries(f))).catch(() => ({}));
    const id = String((body as Record<string, unknown>).cpm_trans_id ?? '');
    const [p] = await db.query<{ id: string }>(`select id from payments where id = $1 and provider = 'cinetpay'`, [id]);
    await hint(p?.id);
    return c.text('ok');
  });
  app.post('/api/webhooks/fedapay', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { entity?: { id?: number | string } };
    const [p] = await db.query<{ id: string }>(`select id from payments where provider = 'fedapay' and provider_ref = $1`, [String(body.entity?.id ?? '')]);
    await hint(p?.id);
    return c.text('ok');
  });
  const mtnHook = async (c: Context) => {
    const body = (await c.req.json().catch(() => ({}))) as { externalId?: string };
    const [p] = await db.query<{ id: string }>(`select id from payments where id = $1 and provider = 'mtn'`, [String(body.externalId ?? '')]);
    await hint(p?.id);
    return c.text('ok');
  };
  app.post('/api/webhooks/mtn', mtnHook);
  app.put('/api/webhooks/mtn', mtnHook);

  // ─── booth sync (Bearer booth token) ───
  const sync = new Hono<{ Variables: { booth: { id: string; country: Country } } }>();
  sync.use('*', async (c, next) => {
    const token = c.req.header('authorization')?.replace(/^Bearer /, '') ?? '';
    const [booth] = token ? await db.query<{ id: string; country: Country }>(
      `select bo.id, v.country from booths bo join events e on e.id = bo.event_id join venues v on v.id = e.venue_id where bo.token_hash = $1`,
      [await sha256Hex(token)]) : [];
    if (!booth) return c.json({ error: 'unauthorized' }, 401);
    c.set('booth', booth);
    await db.query('update booths set last_seen_at = $2 where id = $1', [booth.id, Date.now()]);
    await next();
  });

  // Merchant numbers shown to cashiers for the manual fallback.
  sync.get('/me', (c) => c.json({ ...c.get('booth'), merchant: d.payments.merchant }));

  sync.post('/push', async (c) => {
    const { rows } = Push.parse(await c.req.json());
    const booth = c.get('booth');
    const refused: number[] = [];
    await db.tx(async (t) => {
      for (const [i, r] of rows.entries()) if (!(await applyBoothRowSafely(t, booth.id, r.tbl, r.row))) refused.push(i);
    });
    return c.json({ accepted: rows.length - refused.length, refused });
  });

  sync.get('/pull', async (c) => {
    const since = Number(c.req.query('since') ?? 0) || 0;
    return c.json(await db.tx(async (t) => {
      await t.query('set transaction isolation level repeatable read read only'); // one snapshot for all tables
      return pullForBooth(t, c.get('booth').id, since);
    }));
  });

  const UploadReq = z.object({ photoId: z.string(), kind: z.enum(['thumb', 'preview', 'deliverable']) });
  const keyFor = (kind: string, bookingId: string, photoId: string) =>
    `${kind}s/${bookingId}/${photoId}.${kind === 'deliverable' ? 'jpg' : 'webp'}`;
  const ownPhoto = async (boothId: string, photoId: string) => {
    const [p] = await db.query<{ booking_id: string }>(
      'select p.booking_id from photos p join bookings b on b.id = p.booking_id where p.id = $1 and b.booth_id = $2', [photoId, boothId]);
    if (!p) throw new PayError(404, 'photo_not_found');
    return p.booking_id;
  };
  sync.post('/upload-url', async (c) => {
    const u = UploadReq.parse(await c.req.json());
    const key = keyFor(u.kind, await ownPhoto(c.get('booth').id, u.photoId), u.photoId);
    return c.json({ key, ...(await d.storage.signUpload(key, u.kind === 'deliverable' ? 'image/jpeg' : 'image/webp')) });
  });
  sync.post('/uploaded', async (c) => {
    const u = UploadReq.parse(await c.req.json());
    const key = keyFor(u.kind, await ownPhoto(c.get('booth').id, u.photoId), u.photoId);
    await db.query(
      `update photos set ${u.kind}_key = $2, upload_status = case when $3 = 'deliverable' then 'done' when upload_status = 'done' then 'done' else 'preview_done' end where id = $1`,
      [u.photoId, key, u.kind]);
    return c.json({ ok: true });
  });

  // Cashier Mobile Money: the booth sends the order with the request (it may not be synced yet).
  const BoothPay = z.object({
    order: z.record(z.string(), z.unknown()), items: z.array(z.record(z.string(), z.unknown())),
    paymentId: z.string().min(1), method: z.enum(MOMO), phone: z.string().max(25).optional(), receivedBy: z.string().optional(),
  });
  sync.post('/payments', async (c) => {
    const b = BoothPay.parse(await c.req.json());
    const booth = c.get('booth');
    await db.tx(async (t) => {
      if (!(await applyBoothRow(t, booth.id, 'orders', b.order))) throw new PayError(400, 'order_refused');
      for (const it of b.items) await applyBoothRow(t, booth.id, 'order_items', it);
    });
    const phone = b.phone ? normalizePhone(booth.country, b.phone) ?? undefined : undefined;
    if (b.phone && !phone) throw new PayError(400, 'invalid_phone');
    const r = await startPayment(db, d.payments, {
      orderId: String(b.order.id), paymentId: b.paymentId, method: b.method as Method, country: booth.country, phone,
      description: 'Picture Me Please', returnUrl: returnTo('/merci'), receivedBy: b.receivedBy ?? null,
    });
    return c.json({ ...(r.kind === 'redirect' ? { kind: 'redirect', url: r.url } : { kind: 'push' }), provider: r.provider });
  });
  const boothPayment = async (boothId: string, id: string) => {
    const [p] = await db.query('select p.id from payments p join orders o on o.id = p.order_id where p.id = $1 and o.booth_id = $2', [id, boothId]);
    if (!p) throw new PayError(404, 'payment_not_found');
  };
  sync.get('/payments/:id', async (c) => {
    await boothPayment(c.get('booth').id, c.req.param('id'));
    const p = await refreshPayment(db, d.payments, c.req.param('id'));
    return c.json({ status: p.status, operatorRef: p.operator_ref });
  });
  // "Verify transaction": the cashier forces a provider check, optionally with the id on the customer's SMS receipt.
  sync.post('/payments/:id/verify', async (c) => {
    const { operatorRef } = z.object({ operatorRef: z.string().trim().max(64).optional() }).parse(await c.req.json().catch(() => ({})));
    await boothPayment(c.get('booth').id, c.req.param('id'));
    const p = await refreshPayment(db, d.payments, c.req.param('id'), { force: true });
    const mismatch = !!operatorRef && !!p.operator_ref && operatorRef.toUpperCase() !== p.operator_ref.toUpperCase();
    return c.json({ status: p.status, operatorRef: p.operator_ref, operatorMismatch: mismatch });
  });

  app.route('/api/sync', sync);
  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  return app;
}

type BookingRow = { id: string; status: string; pin_hash: string; booth_id: string; slot_id: string | null; hold_expires_at: number | null; country: Country; phone: string; full_name: string | null };
async function bookingByToken(db: Db, token: string): Promise<BookingRow> {
  const [b] = await db.query<BookingRow>(
    `select b.id, b.status, b.pin_hash, b.booth_id, b.slot_id, b.hold_expires_at, v.country, c.phone, c.full_name
     from bookings b join customers c on c.id = b.customer_id join booths bo on bo.id = b.booth_id
       join events e on e.id = bo.event_id join venues v on v.id = e.venue_id
     where b.public_token = $1`, [token]);
  if (!b) throw new PayError(404, 'booking_not_found');
  return b;
}

async function galleryAuth(c: Context, d: CloudDeps): Promise<BookingRow> {
  const bk = await bookingByToken(d.db, c.req.param('token')!);
  const session = c.req.header('authorization')?.replace(/^Bearer /, '') ?? '';
  if (!(await verifyToken(d.secret, session, `g:${bk.id}`))) throw new PayError(401, 'gallery_login_required');
  return bk;
}

/** Photos the family may download: digital lines of paid orders (booth packages and online purchases alike). */
async function entitledPhotoIds(db: Db, bookingId: string): Promise<Set<string>> {
  return new Set((await db.query<{ photo_id: string }>(
    `select distinct i.photo_id from order_items i join orders o on o.id = i.order_id
     where o.booking_id = $1 and o.status = 'paid' and i.kind = 'digital' and i.photo_id is not null`, [bookingId])).map((r) => r.photo_id));
}

function phoneFor(p: { phone?: string; phoneCountry?: Country }, fallbackCountry: Country): string | undefined {
  if (!p.phone) return undefined;
  const e164 = normalizePhone(p.phoneCountry ?? fallbackCountry, p.phone);
  if (!e164) throw new PayError(400, 'invalid_phone');
  return e164;
}

