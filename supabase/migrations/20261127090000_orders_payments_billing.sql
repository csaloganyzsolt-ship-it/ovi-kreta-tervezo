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
