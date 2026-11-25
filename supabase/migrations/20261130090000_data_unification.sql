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
