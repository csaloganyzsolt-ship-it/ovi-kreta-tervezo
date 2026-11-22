-- Felhasználói portál: profiles + orders tábla, regisztrációs trigger, RLS. Újrafuttatható (idempotens).
-- Az írásokat (profil mentés, rendelések, fióktörlés) a backend végzi a titkos kulccsal; a böngésző csak a saját sorait olvashatja.

-- ---------- profiles ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  full_name text,
  billing_name text,
  billing_zip text,
  billing_city text,
  billing_address text,
  billing_tax_id text,
  kindergarten_name text,
  group_name text,
  subscription_tier text not null default 'free',
  updated_at timestamptz not null default now()
);

alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists full_name text;
alter table public.profiles add column if not exists billing_name text;
alter table public.profiles add column if not exists billing_zip text;
alter table public.profiles add column if not exists billing_city text;
alter table public.profiles add column if not exists billing_address text;
alter table public.profiles add column if not exists billing_tax_id text;
alter table public.profiles add column if not exists kindergarten_name text;
alter table public.profiles add column if not exists group_name text;
alter table public.profiles add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_field_lengths_check' and conrelid = 'public.profiles'::regclass) then
    alter table public.profiles add constraint profiles_field_lengths_check check (
      char_length(coalesce(full_name, '')) <= 120
      and char_length(coalesce(billing_name, '')) <= 120
      and char_length(coalesce(billing_zip, '')) <= 10
      and char_length(coalesce(billing_city, '')) <= 80
      and char_length(coalesce(billing_address, '')) <= 120
      and char_length(coalesce(billing_tax_id, '')) <= 30
      and char_length(coalesce(kindergarten_name, '')) <= 120
      and char_length(coalesce(group_name, '')) <= 80
    );
  end if;
end $$;

-- ---------- orders ----------
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  user_id uuid references auth.users (id) on delete set null,
  user_email text,
  document_id text,
  plan_mode text,
  plan_key text,
  amount integer not null,
  coupon_code text,
  payment_method text,
  status text not null default 'pending',
  invoice_number text,
  created_at timestamptz not null default now()
);

alter table public.orders add column if not exists plan_key text;
alter table public.orders alter column status set default 'pending';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orders_status_check' and conrelid = 'public.orders'::regclass) then
    alter table public.orders add constraint orders_status_check check (status in ('pending', 'paid', 'failed', 'cancelled'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_amount_check' and conrelid = 'public.orders'::regclass) then
    alter table public.orders add constraint orders_amount_check check (amount >= 0);
  end if;
end $$;

create index if not exists idx_orders_user_id_created on public.orders (user_id, created_at desc);
create index if not exists idx_orders_user_email on public.orders (user_email);
create index if not exists idx_orders_document_id on public.orders (document_id);

-- ---------- updated_at ----------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------- regisztrációkor profil létrehozása ----------
-- SECURITY DEFINER csak a trigger miatt kell (az auth sémából ír a public sémába); rögzített search_path, API-ból nem hívható.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 120))
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- A trigger bevezetése előtt regisztrált felhasználók profilja.
insert into public.profiles (id, email, full_name)
select u.id, u.email, left(coalesce(u.raw_user_meta_data ->> 'full_name', ''), 120)
from auth.users u
on conflict (id) do nothing;

-- ---------- RLS ----------
alter table public.profiles enable row level security;
alter table public.orders enable row level security;

drop policy if exists "Users can insert own profile" on public.profiles;
drop policy if exists "Users can update own profile" on public.profiles;
drop policy if exists "Users can view own profile" on public.profiles;
drop policy if exists "profiles_select_own" on public.profiles;
drop policy if exists "profiles_update_own" on public.profiles;
drop policy if exists "orders_select_own" on public.orders;

create policy "profiles_select_own" on public.profiles
  for select to authenticated
  using ((select auth.uid()) = id);

create policy "profiles_update_own" on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- A rendelés összege és állapota nem módosítható a böngészőből: csak olvasási szabály van, az írást a backend végzi.
create policy "orders_select_own" on public.orders
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- ---------- Data API jogosultságok ----------
revoke all on public.profiles from anon, authenticated;
revoke all on public.orders from anon, authenticated;

grant select on public.profiles to authenticated;
grant update (full_name, billing_name, billing_zip, billing_city, billing_address, billing_tax_id, kindergarten_name, group_name)
  on public.profiles to authenticated;
grant select on public.orders to authenticated;

-- Az eseményindító-függvény (automatikus RLS) nem szolgál API-hívásra.
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
