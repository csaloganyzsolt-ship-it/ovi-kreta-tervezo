-- Hírlevél-feliratkozás (GDPR) és admin jogosultsági alap. Újrafuttatható (idempotens).
-- Az is_admin, a newsletter_* mezők és a kampánynapló csak a backendből (titkos kulccsal) írhatók; a böngésző egyiket sem módosíthatja.

-- ---------- profiles ----------
alter table public.profiles add column if not exists is_admin boolean not null default false;
alter table public.profiles add column if not exists newsletter_subscribed boolean not null default false;
alter table public.profiles add column if not exists newsletter_subscribed_at timestamptz;
-- A volatilis alapérték soronként új UUID-t ad a meglévő profiloknak is.
alter table public.profiles add column if not exists newsletter_token uuid not null default gen_random_uuid();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_newsletter_token_key' and conrelid = 'public.profiles'::regclass) then
    alter table public.profiles add constraint profiles_newsletter_token_key unique (newsletter_token);
  end if;
end $$;

-- ---------- newsletter_campaigns ----------
create table if not exists public.newsletter_campaigns (
  id uuid primary key default gen_random_uuid(),
  subject text not null,
  html_body text not null,
  recipient_filter text not null,
  recipient_count integer not null default 0,
  sent_count integer not null default 0,
  failed_count integer not null default 0,
  sent_by text,
  created_at timestamptz not null default now()
);

create index if not exists idx_newsletter_campaigns_created on public.newsletter_campaigns (created_at desc);

-- RLS szabály nélkül: csak a titkos (service_role) kulcs fér hozzá.
alter table public.newsletter_campaigns enable row level security;
revoke all on public.newsletter_campaigns from anon, authenticated;

-- ---------- regisztrációkor profil létrehozása (hírlevél-hozzájárulással) ----------
-- A raw_user_meta_data->>'newsletter_subscribed' csak a pontos 'true' érték esetén jelent feliratkozást.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  subscribed boolean := coalesce(new.raw_user_meta_data ->> 'newsletter_subscribed', '') = 'true';
begin
  insert into public.profiles (id, email, full_name, newsletter_subscribed, newsletter_subscribed_at)
  values (
    new.id,
    new.email,
    left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 120),
    subscribed,
    case when subscribed then now() end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- ---------- Data API jogosultságok ----------
-- Az authenticated csak a nem titkos oszlopokat olvashatja (a newsletter_token a levelekben lévő leiratkozó link kulcsa, nem szivároghat);
-- írni továbbra is csak a számlázási és óvodai alapadatokat írhatja: az is_admin és a newsletter_* oszlopokra nincs UPDATE jog.
revoke select on public.profiles from authenticated;
grant select (id, email, full_name, billing_name, billing_zip, billing_city, billing_address, billing_tax_id, kindergarten_name, group_name, subscription_tier, updated_at, is_admin, newsletter_subscribed, newsletter_subscribed_at)
  on public.profiles to authenticated;
