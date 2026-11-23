-- Vendég hírlevél-feliratkozók (fizetéskor, regisztráció nélkül). Újrafuttatható (idempotens).
create table if not exists public.newsletter_guests (
  email text primary key,
  name text,
  newsletter_token uuid unique default gen_random_uuid(),
  subscribed_at timestamptz default now(),
  unsubscribed boolean default false
);

-- Csak a szerver (service_role) fér hozzá; az anon és authenticated szerepkör nem.
alter table public.newsletter_guests enable row level security;

drop policy if exists "newsletter_guests_no_access" on public.newsletter_guests;
create policy "newsletter_guests_no_access" on public.newsletter_guests
  for all using (false) with check (false);

revoke all on public.newsletter_guests from anon, authenticated;
grant select, insert, update on public.newsletter_guests to service_role;
