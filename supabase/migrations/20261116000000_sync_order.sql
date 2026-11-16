-- Booth pull cursors assume server_seq order = commit order. Without this, a transaction that takes
-- a sequence value and commits late is skipped for ever by a booth that already pulled past it
-- (symptom: a paid online booking that never reaches the booth).
-- One transaction-level advisory lock serialises writers of synced tables; volume here is tiny.
create or replace function bump_seq() returns trigger language plpgsql as $$
begin
  perform pg_advisory_xact_lock(7453001);
  new.server_seq := nextval('sync_seq');
  return new;
end $$;

-- One row per PIN attempt, so "5 wrong tries" holds under parallel requests too.
alter table gallery_attempts add column id text;
