-- Run manually in the Supabase SQL editor after the tables exist.
-- Enables RLS with no policies: no role (including anon/authenticated) can
-- read or write these tables directly. All access goes through server code
-- using the service role, which bypasses RLS.
alter table accounts enable row level security;
alter table positions enable row level security;
alter table orders enable row level security;
alter table transactions enable row level security;
