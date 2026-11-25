-- ============================================================================
-- RUN_ALL_PENDING_MIGRATIONS.sql
-- A 20261127 óta készült összes migráció egyben (Supabase SQL Editorba másolható, egyszeri futtatással szinkronba hozza az éles adatbázist).
-- Teljesen idempotens: bármennyiszer újrafuttatható. A tartalom a supabase/migrations/ megfelelő fájljaival betűre egyezik
-- (a tests/ ezt ellenőrzi). Előfeltétel: a 20261126-ig tartó migrációk már lefutottak (profiles, orders, system_settings, deleted_accounts_archive).
-- ============================================================================

-- >>>>>>>>>> 20261127090000_orders_payments_billing.sql
-- 3. fázis: a fizetési állapot, a számlázási metaadatok és a kézbesítés a Supabase `orders` táblában él (nincs helyi `data/` mappa, nincs tárolt számla-PDF).
-- A migráció idempotens, és a korábban csak kézzel létrehozott táblák (documents, coupons, coupon_redemptions) sémáját is rögzíti.
-- Minden itt szereplő tábla RLS-sel védett: a böngészőből nem érhető el, csak a backend (service_role) fér hozzá.

-- ---------- orders: fizetés, számla, kézbesítés ----------
alter table public.orders add column if not exists session_id text;
alter table public.orders add column if not exists provider text;
alter table public.orders add column if not exists provider_payment_id text;
alter table public.orders add column if not exists provider_status text;
alter table public.orders add column if not exists billing_profile text;
alter table public.orders add column if not exists billing jsonb;
alter table public.orders add column if not exists title text;
alter table public.orders add column if not exists list_price integer;
alter table public.orders add column if not exists coupon_percent integer;
alter table public.orders add column if not exists paid_at timestamptz;
alter table public.orders add column if not exists invoice_issued_at timestamptz;
alter table public.orders add column if not exists invoice_status text;
alter table public.orders add column if not exists delivery_count integer not null default 0;
alter table public.orders add column if not exists delivered_at timestamptz;
alter table public.orders add column if not exists redemption_logged boolean not null default false;
alter table public.orders add column if not exists document_synced boolean not null default false;
alter table public.orders add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orders_provider_check' and conrelid = 'public.orders'::regclass) then
    alter table public.orders add constraint orders_provider_check check (provider is null or provider in ('barion', 'stripe'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_billing_profile_check' and conrelid = 'public.orders'::regclass) then
    alter table public.orders add constraint orders_billing_profile_check check (billing_profile is null or billing_profile in ('ev', 'kft'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_delivery_count_check' and conrelid = 'public.orders'::regclass) then
    alter table public.orders add constraint orders_delivery_count_check check (delivery_count >= 0);
  end if;
end $$;

-- Egyedi fizetési azonosító (Barion PaymentId / Stripe session): csak a nem üres értékekre, így a kuponos (szolgáltató nélküli) rendelések nem ütköznek.
create unique index if not exists orders_provider_payment_id_key
  on public.orders (provider_payment_id) where provider_payment_id is not null and provider_payment_id <> '';
create unique index if not exists orders_session_id_key
  on public.orders (session_id) where session_id is not null and session_id <> '';
create index if not exists idx_orders_status_created on public.orders (status, created_at desc);

-- ---------- documents: mentett tervezetek ----------
create table if not exists public.documents (
  document_id text primary key,
  plan_mode text,
  unlocked boolean not null default false,
  data jsonb not null default '{}'::jsonb,
  user_id uuid references auth.users (id) on delete set null,
  user_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.documents add column if not exists plan_mode text;
alter table public.documents add column if not exists unlocked boolean not null default false;
alter table public.documents add column if not exists data jsonb not null default '{}'::jsonb;
alter table public.documents add column if not exists user_id uuid references auth.users (id) on delete set null;
alter table public.documents add column if not exists user_email text;
alter table public.documents add column if not exists created_at timestamptz not null default now();
alter table public.documents add column if not exists updated_at timestamptz not null default now();
create index if not exists idx_documents_user_id on public.documents (user_id);
create index if not exists idx_documents_user_email on public.documents (user_email);

-- ---------- coupons: kuponkódok ----------
create table if not exists public.coupons (
  code text primary key,
  discount_percent integer not null check (discount_percent between 1 and 100),
  max_uses integer,
  valid_until timestamptz,
  is_active boolean not null default true,
  note text,
  created_at timestamptz not null default now()
);
alter table public.coupons add column if not exists discount_percent integer not null default 100;
alter table public.coupons add column if not exists max_uses integer;
alter table public.coupons add column if not exists valid_until timestamptz;
alter table public.coupons add column if not exists is_active boolean not null default true;
alter table public.coupons add column if not exists note text;
alter table public.coupons add column if not exists created_at timestamptz not null default now();

-- ---------- coupon_redemptions: kuponbeváltások naplója ----------
create table if not exists public.coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  coupon_code text not null,
  user_email text,
  document_id text,
  plan_mode text,
  original_price integer,
  discount_amount integer,
  final_price integer,
  used_at timestamptz not null default now()
);
alter table public.coupon_redemptions add column if not exists user_email text;
alter table public.coupon_redemptions add column if not exists document_id text;
alter table public.coupon_redemptions add column if not exists plan_mode text;
alter table public.coupon_redemptions add column if not exists original_price integer;
alter table public.coupon_redemptions add column if not exists discount_amount integer;
alter table public.coupon_redemptions add column if not exists final_price integer;
alter table public.coupon_redemptions add column if not exists used_at timestamptz not null default now();
create index if not exists idx_coupon_redemptions_code on public.coupon_redemptions (coupon_code);

-- ---------- RLS: csak a backend fér hozzá ----------
alter table public.documents enable row level security;
alter table public.coupons enable row level security;
alter table public.coupon_redemptions enable row level security;

drop policy if exists "documents_no_access" on public.documents;
create policy "documents_no_access" on public.documents for all using (false) with check (false);
drop policy if exists "coupons_no_access" on public.coupons;
create policy "coupons_no_access" on public.coupons for all using (false) with check (false);
drop policy if exists "coupon_redemptions_no_access" on public.coupon_redemptions;
create policy "coupon_redemptions_no_access" on public.coupon_redemptions for all using (false) with check (false);

revoke all on public.documents from anon, authenticated;
revoke all on public.coupons from anon, authenticated;
revoke all on public.coupon_redemptions from anon, authenticated;

-- A rendelések tulajdonosa csak a saját, számlázási szempontból nem érzékeny oszlopait olvashatja (a fizetési azonosítók és a számlázási cím nem).
revoke select on public.orders from authenticated;
grant select (id, order_number, user_id, user_email, document_id, plan_mode, plan_key, amount, coupon_code, payment_method, status, invoice_number, created_at)
  on public.orders to authenticated;

-- ---------- system_settings: új kulcsok (meglévő érték nem íródik felül) ----------
insert into public.system_settings (key, value) values
  ('billing_profile', '"ev"'::jsonb),
  ('payment_provider', '"barion"'::jsonb)
on conflict (key) do nothing;

-- >>>>>>>>>> 20261128090000_notification_email_setting.sql
-- Üzemeltetői / értesítési e-mail cím az Admin Központból (üres: a Render környezeti változói a tartalék).
-- A meglévő érték nem íródik felül; a módosításokat a system_settings_history trigger naplózza.
insert into public.system_settings (key, value) values
  ('notification_email', '""'::jsonb)
on conflict (key) do nothing;

-- >>>>>>>>>> 20261128100000_split_notification_emails.sql
-- Külön számlázási/rendelési és hiba-/tesztelési/visszajelzési értesítési e-mail cím.
-- A seed sorok miatt az első mentés UPDATE, így a system_settings_history trigger naplózza.
insert into public.system_settings (key, value) values
  ('billing_notification_email', '""'::jsonb),
  ('error_notification_email', '""'::jsonb)
on conflict (key) do nothing;

-- >>>>>>>>>> 20261129090000_orders_last_error.sql
-- Kifizetett rendelés számlázási / kézbesítési hibájának rögzítése (a rendelés fizetett marad).
-- A kód ezek nélkül is működik; a hibák megjelenítéséhez az Admin Központban kell.
alter table public.orders add column if not exists last_error text;
alter table public.orders add column if not exists last_error_at timestamptz;

-- >>>>>>>>>> 20261130090000_data_unification.sql
-- Adat-egységesítés: egyetlen hírlevél-tábla, vendégadatok automatikus összekapcsolása regisztrációkor,
-- documents.unlocked <-> orders.status szinkron, árva oszlopok kivezetése, lejárt archívumok takarítása.
-- Teljesen idempotens (újrafuttatható).

-- ---------- 1. newsletter_subscribers: a profiles és a newsletter_guests helyett ----------
create table if not exists public.newsletter_subscribers (
  email text primary key,
  user_id uuid references auth.users (id) on delete set null,
  name text,
  newsletter_token uuid not null default gen_random_uuid() unique,
  subscribed boolean not null default true,
  subscribed_at timestamptz default now(),
  unsubscribed_at timestamptz,
  constraint newsletter_subscribers_email_lower check (email = lower(email))
);

create index if not exists idx_newsletter_subscribers_user_id on public.newsletter_subscribers (user_id);
create index if not exists idx_newsletter_subscribers_subscribed on public.newsletter_subscribers (subscribed);

alter table public.newsletter_subscribers enable row level security;

drop policy if exists "newsletter_subscribers_no_access" on public.newsletter_subscribers;
create policy "newsletter_subscribers_no_access" on public.newsletter_subscribers
  for all using (false) with check (false);

revoke all on public.newsletter_subscribers from anon, authenticated;
grant select, insert, update on public.newsletter_subscribers to service_role;

-- Adatmigráció (a régi tokenek megmaradnak, így a már kiküldött leiratkozó linkek érvényesek). Csak akkor fut, ha a régi oszlopok/táblák még léteznek.
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'newsletter_token') then
    insert into public.newsletter_subscribers (email, user_id, newsletter_token, subscribed, subscribed_at, unsubscribed_at)
    select lower(trim(p.email)), p.id, p.newsletter_token, p.newsletter_subscribed,
           case when p.newsletter_subscribed then coalesce(p.newsletter_subscribed_at, now()) end,
           case when not p.newsletter_subscribed then now() end
    from public.profiles p
    where p.email is not null and trim(p.email) <> ''
    on conflict (email) do nothing;
  end if;

  if to_regclass('public.newsletter_guests') is not null then
    insert into public.newsletter_subscribers (email, user_id, name, newsletter_token, subscribed, subscribed_at, unsubscribed_at)
    select lower(trim(g.email)),
           (select p.id from public.profiles p where lower(p.email) = lower(trim(g.email)) limit 1),
           g.name,
           coalesce(g.newsletter_token, gen_random_uuid()),
           not coalesce(g.unsubscribed, false),
           g.subscribed_at,
           case when coalesce(g.unsubscribed, false) then now() end
    from public.newsletter_guests g
    where g.email is not null and trim(g.email) <> ''
    on conflict (email) do update set
      -- A vendég hozzájárulás külön érvényes: ha a címen bármelyik oldalon feliratkozás van, az marad aktív.
      subscribed = public.newsletter_subscribers.subscribed or excluded.subscribed,
      unsubscribed_at = case when public.newsletter_subscribers.subscribed or excluded.subscribed then null else public.newsletter_subscribers.unsubscribed_at end,
      name = coalesce(public.newsletter_subscribers.name, excluded.name);
  end if;
end $$;

-- ---------- 2. Regisztrációkor profil + hírlevél-feliratkozás ----------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  subscribed boolean := coalesce(new.raw_user_meta_data ->> 'newsletter_subscribed', '') = 'true';
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, lower(new.email), left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 120))
  on conflict (id) do nothing;

  if subscribed and new.email is not null then
    insert into public.newsletter_subscribers (email, user_id, subscribed, subscribed_at)
    values (lower(trim(new.email)), new.id, true, now())
    on conflict (email) do update set subscribed = true, subscribed_at = now(), unsubscribed_at = null;
  end if;
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- ---------- 3. Vendégadatok összekapcsolása az e-mail megerősítésekor ----------
-- A backend (claimGuestRecords) ugyanezt végzi belépéskor; mindkettő idempotens.
create or replace function public.claim_guest_records(p_user_id uuid, p_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_billing jsonb;
begin
  if p_user_id is null or v_email = '' then
    return;
  end if;

  update public.orders set user_id = p_user_id where user_id is null and lower(user_email) = v_email;
  update public.documents set user_id = p_user_id where user_id is null and lower(user_email) = v_email;
  update public.newsletter_subscribers set user_id = p_user_id where user_id is null and email = v_email;

  -- Üres számlázási mezők előtöltése a legutóbbi, számlázási adattal rendelkező rendelésből.
  if exists (
    select 1 from public.profiles
    where id = p_user_id
      and coalesce(billing_name, '') = '' and coalesce(billing_zip, '') = '' and coalesce(billing_city, '') = ''
      and coalesce(billing_address, '') = '' and coalesce(billing_tax_id, '') = ''
  ) then
    select o.billing into v_billing
    from public.orders o
    where o.user_id = p_user_id and o.billing is not null
    order by o.created_at desc
    limit 1;

    if v_billing is not null then
      update public.profiles set
        billing_name = left(coalesce(v_billing ->> 'name', ''), 120),
        billing_zip = left(coalesce(v_billing ->> 'zip', ''), 10),
        billing_city = left(coalesce(v_billing ->> 'city', ''), 80),
        billing_address = left(coalesce(v_billing ->> 'address', ''), 120),
        billing_tax_id = left(coalesce(v_billing ->> 'taxId', v_billing ->> 'tax_id', ''), 30)
      where id = p_user_id;
    end if;
  end if;
end;
$$;

revoke execute on function public.claim_guest_records(uuid, text) from public, anon, authenticated;

create or replace function public.on_auth_user_email_confirmed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.claim_guest_records(new.id, new.email);
  return new;
end;
$$;

revoke execute on function public.on_auth_user_email_confirmed() from public, anon, authenticated;

-- A név szándékosan az on_auth_user_created után rendeződik (a triggerek névsorrendben futnak): előbb létrejön a profil, aztán töltődik elő.
drop trigger if exists on_auth_user_created_claim_guest_records on auth.users;
create trigger on_auth_user_created_claim_guest_records
  after insert or update of email_confirmed_at on auth.users
  for each row when (new.email_confirmed_at is not null)
  execute function public.on_auth_user_email_confirmed();

-- A már megerősített fiókok visszamenőleges összekapcsolása.
do $$
declare
  u record;
begin
  for u in select id, email from auth.users where email_confirmed_at is not null loop
    perform public.claim_guest_records(u.id, u.email);
  end loop;
end $$;

-- ---------- 4. documents.unlocked <-> orders.status = 'paid' ----------
-- Az orders.document_id szándékosan nem külső kulcs (a rendelés számviteli bizonylat, a tervezet törölhető), de indexelt és a fizetés feloldja a tervet.
create index if not exists idx_orders_document_id on public.orders (document_id) where document_id is not null;

create or replace function public.sync_document_unlocked()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'paid' and new.document_id is not null then
    update public.documents set unlocked = true where document_id = new.document_id and unlocked = false;
  end if;
  return new;
end;
$$;

revoke execute on function public.sync_document_unlocked() from public, anon, authenticated;

drop trigger if exists orders_sync_document_unlocked on public.orders;
create trigger orders_sync_document_unlocked
  after insert or update of status, document_id on public.orders
  for each row execute function public.sync_document_unlocked();

update public.documents d set unlocked = true
where d.unlocked = false
  and exists (select 1 from public.orders o where o.document_id = d.document_id and o.status = 'paid');

-- ---------- 5. Árva oszlopok kivezetése ----------
-- A hírlevél-adatok a newsletter_subscribers táblában élnek; a profiles.subscription_tier sosem volt bekötve.
revoke select on public.profiles from authenticated;
grant select (id, email, full_name, billing_name, billing_zip, billing_city, billing_address, billing_tax_id, kindergarten_name, group_name, updated_at, is_admin)
  on public.profiles to authenticated;

alter table public.profiles drop column if exists newsletter_subscribed;
alter table public.profiles drop column if exists newsletter_subscribed_at;
alter table public.profiles drop column if exists newsletter_token;
alter table public.profiles drop column if exists subscription_tier;

drop table if exists public.newsletter_guests;

-- ---------- 6. Lejárt törölt-fiók archívumok takarítása ----------
-- A gazdátlan (user_id nélküli) tervezetek is törlődnek; hívja a backend vagy ütemezett feladat (pl. select public.purge_expired_deleted_accounts();).
create or replace function public.purge_expired_deleted_accounts()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.documents
  where user_id is null
    and document_id in (select unnest(document_ids) from public.deleted_accounts_archive where restore_until < now());

  with removed as (
    delete from public.deleted_accounts_archive where restore_until < now() returning 1
  )
  select count(*) into v_count from removed;
  return v_count;
end;
$$;

revoke execute on function public.purge_expired_deleted_accounts() from public, anon, authenticated;
grant execute on function public.purge_expired_deleted_accounts() to service_role;
