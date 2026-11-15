/**
 * Booth-local SQLite schema (Phase 1 subset of the approved design).
 * Synced tables carry createdAt/updatedAt/deletedAt/serverSeq; times are epoch ms.
 * Cloud-owned tables (countries, venues, events, booths, time_slots, packages) arrive with sync in Phase 2,
 * so their ids are stored here as plain text without FK.
 */
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const now = sql`(cast(unixepoch('subsec') * 1000 as integer))`;
const synced = {
  createdAt: integer('created_at').notNull().default(now),
  updatedAt: integer('updated_at').notNull().default(now),
  deletedAt: integer('deleted_at'),
  serverSeq: integer('server_seq'),
};

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  authUserId: text('auth_user_id').unique(),
  fullName: text('full_name').notNull(),
  phone: text('phone'),
  email: text('email'),
  role: text('role', { enum: ['admin', 'supervisor', 'host', 'photographer', 'cashier'] }).notNull(),
  pinHash: text('pin_hash'),
  locale: text('locale', { enum: ['fr', 'en'] }).notNull().default('fr'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  ...synced,
});

export const customers = sqliteTable('customers', {
  id: text('id').primaryKey(),
  phone: text('phone').notNull(),
  fullName: text('full_name'),
  email: text('email'),
  locale: text('locale', { enum: ['fr', 'en'] }).notNull().default('fr'),
  whatsappOptIn: integer('whatsapp_opt_in', { mode: 'boolean' }).notNull().default(true),
  ...synced,
}, (t) => [index('customers_phone').on(t.phone)]);

export const bookings = sqliteTable('bookings', {
  id: text('id').primaryKey(),
  code: text('code').notNull().unique(),
  publicToken: text('public_token').notNull().unique(),
  pinHash: text('pin_hash').notNull(),
  eventId: text('event_id').notNull(),
  boothId: text('booth_id').notNull(),
  slotId: text('slot_id'),
  customerId: text('customer_id').notNull().references(() => customers.id),
  packageId: text('package_id'),
  source: text('source', { enum: ['online', 'walk_in'] }).notNull(),
  status: text('status', {
    enum: ['pending_payment', 'confirmed', 'checked_in', 'in_session', 'shot_complete', 'completed', 'no_show', 'cancelled', 'expired'],
  }).notNull(),
  partySize: integer('party_size').notNull().default(1),
  holdExpiresAt: integer('hold_expires_at'),
  checkedInAt: integer('checked_in_at'),
  checkedInBy: text('checked_in_by').references(() => users.id),
  notes: text('notes'),
  ...synced,
}, (t) => [index('bookings_booth_status').on(t.boothId, t.status)]);

export const cameras = sqliteTable('cameras', {
  id: text('id').primaryKey(),
  boothId: text('booth_id').notNull(),
  name: text('name').notNull(),
  /** Driver preference: 'auto' tries EDSDK then WIA. */
  driver: text('driver', { enum: ['auto', 'edsdk', 'wia', 'mock'] }).notNull().default('auto'),
  armedSessionId: text('armed_session_id'),
  armedBy: text('armed_by').references(() => users.id),
  armedAt: integer('armed_at'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  ...synced,
}, (t) => [
  uniqueIndex('cameras_booth_name').on(t.boothId, t.name),
  uniqueIndex('cameras_armed_session').on(t.armedSessionId).where(sql`armed_session_id is not null`),
]);

export const photoSessions = sqliteTable('photo_sessions', {
  id: text('id').primaryKey(),
  bookingId: text('booking_id').notNull().references(() => bookings.id),
  boothId: text('booth_id').notNull(),
  cameraId: text('camera_id').references(() => cameras.id),
  code: text('code').notNull(),
  dispatchedBy: text('dispatched_by').references(() => users.id),
  photographerId: text('photographer_id').references(() => users.id),
  status: text('status', { enum: ['dispatched', 'armed', 'shot_complete', 'cancelled'] }).notNull(),
  armedAt: integer('armed_at'),
  completedAt: integer('completed_at'),
  ...synced,
});

export const photos = sqliteTable('photos', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => photoSessions.id),
  bookingId: text('booking_id').notNull().references(() => bookings.id),
  seq: integer('seq').notNull(),
  originalName: text('original_name').notNull(),
  /** File name inside Sessions\{sessionId}\ (unique; the camera's name may be suffixed). */
  fileName: text('file_name').notNull(),
  rawFileName: text('raw_file_name'),
  sha256: text('sha256').notNull(),
  width: integer('width'),
  height: integer('height'),
  takenAt: integer('taken_at'),
  ingestStatus: text('ingest_status', { enum: ['ingesting', 'ready', 'failed'] }).notNull(),
  hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
  favorite: integer('favorite', { mode: 'boolean' }).notNull().default(false),
  previewKey: text('preview_key'),
  deliverableKey: text('deliverable_key'),
  uploadStatus: text('upload_status', { enum: ['pending', 'preview_done', 'done', 'failed'] }).notNull().default('pending'),
  ...synced,
}, (t) => [
  uniqueIndex('photos_session_seq').on(t.sessionId, t.seq),
  uniqueIndex('photos_session_sha').on(t.sessionId, t.sha256),
]);

export const orders = sqliteTable('orders', {
  id: text('id').primaryKey(),
  bookingId: text('booking_id').notNull().references(() => bookings.id),
  boothId: text('booth_id'),
  channel: text('channel', { enum: ['booth', 'online'] }).notNull(),
  cashierId: text('cashier_id').references(() => users.id),
  status: text('status', { enum: ['open', 'paid', 'part_refunded', 'refunded', 'void'] }).notNull(),
  subtotalXof: integer('subtotal_xof').notNull().default(0),
  creditAppliedXof: integer('credit_applied_xof').notNull().default(0),
  totalXof: integer('total_xof').notNull().default(0),
  vatBp: integer('vat_bp').notNull(),
  vatXof: integer('vat_xof').notNull().default(0),
  paidAt: integer('paid_at'),
  ...synced,
});

export const orderItems = sqliteTable('order_items', {
  id: text('id').primaryKey(),
  orderId: text('order_id').notNull().references(() => orders.id),
  packageId: text('package_id'),
  photoId: text('photo_id').references(() => photos.id),
  kind: text('kind', { enum: ['deposit', 'bundle', 'print', 'digital'] }).notNull(),
  qty: integer('qty').notNull(),
  unitPriceXof: integer('unit_price_xof').notNull(),
  lineTotalXof: integer('line_total_xof').notNull(),
  ...synced,
});

export const printJobs = sqliteTable('print_jobs', {
  id: text('id').primaryKey(),
  boothId: text('booth_id').notNull(),
  orderItemId: text('order_item_id').notNull().references(() => orderItems.id),
  photoId: text('photo_id').notNull().references(() => photos.id),
  printSize: text('print_size', { enum: ['4x6', '5x7', '8x10', 'custom'] }).notNull(),
  /** Only for 'custom': short × long side in inches, e.g. "6x8". */
  customInches: text('custom_inches'),
  copies: integer('copies').notNull().default(1),
  printerName: text('printer_name'),
  status: text('status', { enum: ['queued', 'printing', 'done', 'failed', 'cancelled'] }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  requestedBy: text('requested_by').references(() => users.id),
  printedAt: integer('printed_at'),
  ...synced,
}, (t) => [index('print_jobs_status').on(t.status)]);

export const auditLogs = sqliteTable('audit_logs', {
  id: text('id').primaryKey(),
  at: integer('at').notNull(),
  boothId: text('booth_id'),
  deviceId: text('device_id'),
  actorId: text('actor_id'),
  actorRole: text('actor_role'),
  action: text('action').notNull(),
  entity: text('entity'),
  entityId: text('entity_id'),
  data: text('data', { mode: 'json' }),
  prevHash: text('prev_hash'),
  hash: text('hash').notNull(),
  serverSeq: integer('server_seq'),
}, (t) => [index('audit_action_entity_at').on(t.action, t.entityId, t.at)]);

// ─── booth-local only ───
export const staffSessions = sqliteTable('staff_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  deviceId: text('device_id').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const syncOutbox = sqliteTable('sync_outbox', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  tbl: text('tbl').notNull(),
  rowId: text('row_id').notNull(),
  payload: text('payload').notNull(),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  createdAt: integer('created_at').notNull(),
});
