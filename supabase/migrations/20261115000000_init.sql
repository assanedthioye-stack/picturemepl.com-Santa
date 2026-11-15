-- Picture Me Please — cloud schema (Supabase Postgres).
-- Synced tables mirror the booth SQLite columns 1:1 (text ids, epoch-ms bigints) so sync is a plain upsert.
-- Every synced row gets server_seq from one sequence: the booth's pull cursor (immune to booth clock drift).

create sequence sync_seq;
create function bump_seq() returns trigger language plpgsql as $$
begin new.server_seq := nextval('sync_seq'); return new; end $$;

-- ─── cloud-owned configuration ───
create table venues (
  id text primary key,
  country text not null check (country in ('SN', 'BJ', 'CI')),
  name text not null,
  city text not null,
  address text,
  active boolean not null default true
);

create table events (
  id text primary key,
  venue_id text not null references venues,
  name_fr text not null,
  name_en text not null,
  starts_on date not null,
  ends_on date not null,
  status text not null default 'live' check (status in ('draft', 'published', 'live', 'closed'))
);

create table booths (
  id text primary key,
  event_id text not null references events,
  name text not null,
  token_hash text not null unique, -- sha256 of the booth's bearer token
  last_seen_at bigint
);

create table time_slots (
  id text primary key,
  booth_id text not null references booths,
  starts_at bigint not null,
  ends_at bigint not null,
  capacity int not null default 1 check (capacity > 0),
  unique (booth_id, starts_at)
);

-- ─── synced with booths (no FKs: rows arrive in booth outbox order) ───
create table customers (
  id text primary key, phone text not null, country text, full_name text, email text,
  locale text not null default 'fr', whatsapp_opt_in boolean not null default true,
  created_at bigint not null, updated_at bigint not null, deleted_at bigint, server_seq bigint
);
create index on customers (phone);

create table bookings (
  id text primary key, code text not null, public_token text not null unique, pin_hash text not null,
  event_id text not null, booth_id text not null, slot_id text, customer_id text not null, package_id text,
  source text not null, status text not null, party_size int not null default 1, hold_expires_at bigint,
  checked_in_at bigint, checked_in_by text, notes text,
  created_at bigint not null, updated_at bigint not null, deleted_at bigint, server_seq bigint,
  unique (booth_id, code) -- codes are per booth: online codes never start with 9, booth walk-ins always do
);
create index on bookings (slot_id, status);
create index on bookings (booth_id, server_seq);

create table photo_sessions (
  id text primary key, booking_id text not null, booth_id text not null, camera_id text, code text not null,
  dispatched_by text, photographer_id text, status text not null, armed_at bigint, completed_at bigint,
  created_at bigint not null, updated_at bigint not null, deleted_at bigint, server_seq bigint
);

create table photos (
  id text primary key, session_id text not null, booking_id text not null, seq int not null,
  original_name text not null, file_name text not null, raw_file_name text, sha256 text not null,
  width int, height int, taken_at bigint, ingest_status text not null,
  hidden boolean not null default false, favorite boolean not null default false,
  -- cloud-managed: set when the booth finishes an upload
  preview_key text, thumb_key text, deliverable_key text, upload_status text not null default 'pending',
  created_at bigint not null, updated_at bigint not null, deleted_at bigint, server_seq bigint
);
create index on photos (booking_id);

create table orders (
  id text primary key, booking_id text not null, booth_id text, channel text not null, cashier_id text,
  status text not null, subtotal_xof bigint not null default 0, credit_applied_xof bigint not null default 0,
  total_xof bigint not null default 0, vat_bp int not null, vat_xof bigint not null default 0, paid_at bigint,
  created_at bigint not null, updated_at bigint not null, deleted_at bigint, server_seq bigint
);
create index on orders (booking_id);
create index on orders (booth_id, server_seq);

create table order_items (
  id text primary key, order_id text not null, package_id text, photo_id text, kind text not null,
  print_size text, qty int not null, unit_price_xof bigint not null, line_total_xof bigint not null,
  created_at bigint not null, updated_at bigint not null, deleted_at bigint, server_seq bigint
);
create index on order_items (order_id);

create table payments (
  id text primary key, order_id text not null, method text not null, provider text,
  idempotency_key text not null unique, provider_tx_id text, amount_xof bigint not null, payer_phone text,
  status text not null, received_by text, drawer_session_id text, confirmed_at bigint,
  -- cloud-managed
  provider_ref text, operator_ref text, provider_data jsonb, last_checked_at bigint,
  created_at bigint not null, updated_at bigint not null, deleted_at bigint, server_seq bigint
);
create index on payments (order_id);
create index on payments (provider, provider_ref);

create table drawer_sessions (
  id text primary key, booth_id text not null, opened_by text not null, opened_at bigint not null,
  opening_float_xof bigint not null, closed_by text, closed_at bigint, counted_xof bigint, expected_xof bigint,
  variance_xof bigint, approved_by text, status text not null,
  created_at bigint not null, updated_at bigint not null, deleted_at bigint, server_seq bigint
);

create table cash_movements (
  id text primary key, drawer_session_id text not null, kind text not null, amount_xof bigint not null,
  payment_id text, by_user text not null, note text,
  created_at bigint not null, updated_at bigint not null, deleted_at bigint, server_seq bigint
);

do $$
declare t text;
begin
  foreach t in array array['customers','bookings','photo_sessions','photos','orders','order_items','payments','drawer_sessions','cash_movements'] loop
    execute format('create trigger %I before insert or update on %I for each row execute function bump_seq()', t || '_seq', t);
  end loop;
end $$;

-- Gallery PIN attempts (rate limit: 5 failures / 15 min / booking).
create table gallery_attempts (booking_id text not null, at bigint not null, ok boolean not null);
create index on gallery_attempts (booking_id, at);

-- The API connects with the service role; nothing is exposed through PostgREST.
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;
