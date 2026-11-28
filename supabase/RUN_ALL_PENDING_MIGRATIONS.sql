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

-- >>>>>>>>>> 20261201090000_email_templates_custom.sql
-- Egyedi e-mail sablonok az Admin Központból: megjelenített név, rendszersablon-jelölő, módosítás ideje, törlési jog, valamint az invoice_only („Csak számla küldése”) rendszersablon.
-- Idempotens. A backend a migráció előtt is működik (a name / is_system oszlop nélkül is menti a sablonokat), de egyedi sablon neve csak ezután tárolódik.

alter table public.email_templates add column if not exists name text not null default '';
alter table public.email_templates add column if not exists is_system boolean not null default false;
alter table public.email_templates add column if not exists updated_at timestamptz not null default now();

update public.email_templates
set is_system = true
where id in ('base_layout', 'welcome_email', 'payment_success', 'feedback_request', 'password_reset', 'invoice_only');

create or replace function public.email_templates_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists email_templates_touch_updated_at on public.email_templates;
create trigger email_templates_touch_updated_at
  before update on public.email_templates
  for each row execute function public.email_templates_touch_updated_at();

-- Az egyedi sablonok törléséhez a backendnek (service_role) törlési jog is kell.
grant select, insert, update, delete on public.email_templates to service_role;

-- „Csak számla küldése”: a már szerkesztett változatot nem írja felül.
insert into public.email_templates (id, name, is_system, subject, body_html) values
  ('invoice_only', 'Csak számla küldése', true, 'Számlája elkészült – OviTervező ({{invoiceNumber}})', $invoice_only$<h1 style="margin:0 0 12px;font-size:22px;color:#1f5f52;">Kedves Kolléganő!</h1>
<p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#2d3b36;">Köszönjük, hogy az OviTervezőt választotta – mellékelten küldjük a vásárlásáról kiállított számlát PDF formátumban.</p>
<p style="margin:0 0 18px;padding:10px 14px;background:#f4fbf7;border-left:4px solid #3fae84;border-radius:8px;font-size:15px;color:#2d3b36;"><strong>Megrendelés témája:</strong> {{topic}}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;background:#f4fbf7;border:1px solid #cfe8da;border-radius:14px;"><tr><td style="padding:14px 18px;font-size:14px;line-height:1.7;color:#2d3b36;">
<div>Rendelésszám: <strong>{{orderId}}</strong></div>
<div>Számlaszám: <strong>{{invoiceNumber}}</strong></div>
<div style="margin-top:6px;color:#1f5f52;font-weight:600;">📎 Csatolmány: Számla (PDF)</div>
</td></tr></table>
<p style="margin:0 0 18px;font-size:14px;line-height:1.5;color:#5b6b64;background:#f6f7f7;border-radius:10px;padding:10px 14px;">A számla elektronikus úton továbbított, nyomtatás nélkül is könyvelhető bizonylat. Kérjük, őrizze meg saját nyilvántartása számára.</p>
<p style="margin:20px 0;text-align:center;"><a href="{{site_url}}" style="display:inline-block;background:#3fae84;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:13px 26px;border-radius:999px;">Új tervezet készítése</a></p>
<p style="margin:0 0 4px;font-size:16px;line-height:1.6;color:#2d3b36;">Sikeres, játékos hetet kívánunk!</p>
<p style="margin:0;font-size:16px;line-height:1.6;color:#2d3b36;">Üdvözlettel,<br><strong>Az OviTervező csapata</strong></p>
<p style="margin:14px 0 0;font-size:14px;color:#5b6b64;">Kérdése van? Nyugodtan válaszoljon közvetlenül erre a levélre, szívesen segítünk!</p>$invoice_only$)
on conflict (id) do update set is_system = true;

-- >>>>>>>>>> 20261202090000_literature_rules_prompt.sql
-- Magyar nyelvű, valós irodalmi anyagra vonatkozó kötelező szabályok a rendszerpromptban.
-- Csak az érintetlen régi alapértéket (md5 egyezés) egészíti ki; az Admin Központban egyedileg módosított promptot NEM írja felül.
-- Idempotens: az új szöveg már nem egyezik a régi ujjlenyomattal, így újrafuttatva nem történik változás.
-- A módosítást a system_settings_history trigger naplózza.

update public.system_settings
set value = jsonb_set(
  value,
  '{system_prompt}',
  to_jsonb((value ->> 'system_prompt') || chr(10) || chr(10) || $rules$IRODALMI ANYAGOK – KÖTELEZŐ SZABÁLYOK (minden tervtípusnál, minden más utasítást megelőznek):
1. KIZÁRÓLAG magyar nyelvű, valóban létező, óvodás korosztálynak szóló magyar gyermekverseket, mondókákat, meséket, dalokat és találós kérdéseket használhatsz: népköltést, népmesét, valamint ismert magyar szerzők műveit (pl. Weöres Sándor, Zelk Zoltán, Gazdag Erzsi, Tamkó Sirató Károly, Kormos István, Szepes Mária, Varga Katalin, Móra Ferenc, Benedek Elek, Móricz Zsigmond, Lázár Ervin).
2. SZIGORÚAN TILOS bármilyen idegen nyelvű (francia, latin, angol, német stb.) vers, mese, mondóka, dalszöveg vagy idézet használata – kivéve, ha a pedagógus a kérésben kifejezetten idegen nyelvű foglalkozást kér. Külföldi mese csak ismert, hivatalos magyar fordításban vagy feldolgozásban hivatkozható.
3. SOHA ne találj ki fiktív verset, mesét, költőt, szerzőt, kötetet, kiadót, évszámot vagy oldalszámot. Ha bizonytalan vagy egy mű létezésében vagy szerzőjében, ne használd: válassz közismert magyar népköltést, vagy jelöld a feladatot saját ötletnek.
4. A felhasznalt_irodalom listába kizárólag a tervben ténylegesen szereplő, valós magyar művek és magyar szakirodalom kerülhetnek.$rules$)
)
where key = 'ai_config'
  and md5(value ->> 'system_prompt') = '466cf7d08e00b597b410442a9b73cccf';

-- >>>>>>>>>> 20261204090000_reviews.sql
-- Ügyfélértékelések: a vásárlói levélből beküldött csillagos vélemény `pending` státusszal mentődik, az admin hagyja jóvá (`approved`),
-- és csak a jóváhagyott értékelés jelenik meg a főoldalon. Idempotens migráció.

create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders (id) on delete set null,
  order_number text,
  customer_name text not null default '',
  customer_email text not null,
  plan_topic text not null default '',
  rating smallint not null check (rating between 1 and 5),
  comment text not null default '',
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  admin_reply_sent_at timestamptz,
  admin_note text,
  created_at timestamptz not null default now()
);

alter table public.reviews add column if not exists order_id uuid references public.orders (id) on delete set null;
alter table public.reviews add column if not exists order_number text;
alter table public.reviews add column if not exists customer_name text not null default '';
alter table public.reviews add column if not exists customer_email text;
alter table public.reviews add column if not exists plan_topic text not null default '';
alter table public.reviews add column if not exists rating smallint;
alter table public.reviews add column if not exists comment text not null default '';
alter table public.reviews add column if not exists status text not null default 'pending';
alter table public.reviews add column if not exists admin_reply_sent_at timestamptz;
alter table public.reviews add column if not exists admin_note text;
alter table public.reviews add column if not exists created_at timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'reviews_status_check' and conrelid = 'public.reviews'::regclass) then
    alter table public.reviews add constraint reviews_status_check check (status in ('pending', 'approved', 'rejected'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'reviews_rating_check' and conrelid = 'public.reviews'::regclass) then
    alter table public.reviews add constraint reviews_rating_check check (rating between 1 and 5);
  end if;
end $$;

-- Rendelésenként egy értékelés (az újrabeküldés felülírja, és újra jóváhagyásra vár).
create unique index if not exists reviews_order_number_key on public.reviews (order_number) where order_number is not null and order_number <> '';
create index if not exists reviews_status_created_idx on public.reviews (status, created_at desc);

-- RLS: publikusan csak a jóváhagyott sorok olvashatók; írni és módosítani kizárólag a backend (service_role) tud, ami megkerüli az RLS-t.
alter table public.reviews enable row level security;

drop policy if exists reviews_public_approved_read on public.reviews;
create policy reviews_public_approved_read on public.reviews
  for select to anon, authenticated
  using (status = 'approved');

-- Az e-mail cím és az admin jegyzet sosem olvasható publikusan, csak a megjelenített mezők.
revoke all on public.reviews from anon, authenticated;
grant select (id, customer_name, plan_topic, rating, comment, status, created_at) on public.reviews to anon, authenticated;

-- >>>>>>>>>> 20261205090000_seed_initial_reviews_and_delete.sql
-- A főoldalon eddig beégetett 6 vélemény átemelése a `reviews` táblába (jóváhagyott állapotban), szerepkör-megjelöléssel.
-- Idempotens: a beszúrás a helyőrző e-mail cím alapján csak egyszer fut le. Figyelem: ha egy átemelt véleményt az Adminban
-- törölsz, a migráció újrafuttatása (pl. a RUN_ALL_PENDING_MIGRATIONS.sql) újra beszúrná.

alter table public.reviews add column if not exists role_label text;

-- A publikus olvasás kiegészül a szerepkör-megjelöléssel (az e-mail és az admin jegyzet továbbra sem olvasható).
grant select (role_label) on public.reviews to anon, authenticated;

insert into public.reviews (customer_name, customer_email, role_label, plan_topic, rating, comment, status, created_at)
select v.name, v.email, v.role_label, '', 5, v.comment, 'approved', now() - make_interval(days => v.days)
from (values
  ('Kovácsné T. Judit', 'korabbi-velemeny-1@ovitervezo.invalid', 'Óvodapedagógus (vegyes csoport)', 14,
   $q$Vasárnap esténként eddig órákat ültem a gép előtt a heti terv miatt. Tegnap kipróbáltam, 10 perc alatt meglett az alap, csak kicsit átírtam a saját csoportomra. Nagyon nagy segítség!$q$),
  ('Szabó Eszter', 'korabbi-velemeny-2@ovitervezo.invalid', 'Óvónő', 21,
   $q$Nem gondoltam volna hogy ilyen jol osszerakja a differenciálást a kicsikre meg a nagyokra is külön. A verseket meg meséket azért átnéztem benne, de rengeteg időt megspórolt.$q$),
  ('Varga-Németh Krisztina', 'korabbi-velemeny-3@ovitervezo.invalid', 'Óvodapedagógus', 32,
   $q$Kicsit szkeptikus voltam az AI-al kapcsolatban, de kolléganőm ajánlotta. A szülői előtt kellett gyorsan egy őszi projektterv, teljesen vállalható szakmai nyelvezetet használ.$q$),
  ('Tóth Anikó', 'korabbi-velemeny-4@ovitervezo.invalid', 'Óvodapedagógus (kiscsoport)', 35,
   $q$Szuper lett a letölthető word doksi, egyből tudtam szerkeszteni. Nekem a vizuális nevelés ötletek tetszettek a legjobban benne, végre nem ugyanazt a sablont kell elővenni.$q$),
  ('Horváthné Gabi', 'korabbi-velemeny-5@ovitervezo.invalid', 'Óvónő', 40,
   $q$Péntek délután mentett meg, mikor kiderült hogy hétfőn jön a szaktanácsadó és még nem volt kész a részletes tervezetem. Köszönöm!!$q$),
  ('Molnár Dóra', 'korabbi-velemeny-6@ovitervezo.invalid', 'Pályakezdő óvodapedagógus', 62,
   $q$Pályakezdőként néha még nehéz jól megfogalmazni a fejlesztési célokat. Ebből nagyon sokat tanulni, és nem sablonos mondatokat ír.$q$)
) as v(name, email, role_label, days, comment)
where not exists (select 1 from public.reviews r where r.customer_email = v.email);

-- >>>>>>>>>> 20261206120000_theme_suggestions.sql
-- Téma-ajánló adatbázis: a tervező „Projekt témája” chipjeit a kiválasztott dátum (vagy hét) alapján ez a tábla adja.
-- category: event = jeles nap / ünnepkör (start_mmdd–end_mmdd ablakkal, az évforduló feletti átnyúlás is megengedett, pl. 12-28 – 01-08),
--           season = évszakos általános téma, general = bármikor ajánlható tartalék. Magasabb priority = előrébb jelenik meg.
-- Idempotens: bármennyiszer újrafuttatható. A seed a title egyedisége miatt nem duplikál (on conflict do nothing).
-- Olvasás: csak az aktív sorok publikusak; írás kizárólag a backendnek (service_role, ami megkerüli az RLS-t).

create table if not exists public.theme_suggestions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  category text not null check (category in ('event', 'season', 'general')),
  season text check (season in ('tavasz', 'nyar', 'osz', 'tel')),
  start_mmdd text check (start_mmdd ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
  end_mmdd text check (end_mmdd ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
  priority integer not null default 50,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists theme_suggestions_title_key on public.theme_suggestions (title);
create index if not exists theme_suggestions_active_category_idx on public.theme_suggestions (is_active, category, priority desc);

alter table public.theme_suggestions enable row level security;

drop policy if exists "theme_suggestions_public_read_active" on public.theme_suggestions;
create policy "theme_suggestions_public_read_active" on public.theme_suggestions
  for select using (is_active = true);

insert into public.theme_suggestions (title, category, season, start_mmdd, end_mmdd, priority) values
  -- Jeles napok, ünnepkörök (1–2 héttel előtte és pár nappal utána)
  ('Karácsony – ajándékkészítés és ünnepi hagyományok', 'event', null, '12-14', '12-27', 100),
  ('Adventi készülődés – koszorúkészítés és gyertyagyújtás', 'event', null, '11-25', '12-22', 90),
  ('Mikulás – csizmák, versek és mondókák', 'event', null, '11-26', '12-08', 98),
  ('Luca-nap – lucabúza ültetése és népszokások', 'event', null, '12-06', '12-14', 85),
  ('Újév – téli köszöntők és jókívánságok', 'event', null, '12-28', '01-08', 85),
  ('Vízkereszt – háromkirályok és téli népszokások', 'event', null, '01-02', '01-10', 80),
  ('Medvenap – a kis medve téli álma', 'event', null, '01-27', '02-05', 80),
  ('Farsang – jelmezek, álarcok és mulatság', 'event', null, '01-25', '03-02', 95),
  ('Téltemetés – kiszebáb és tavaszvárás', 'event', null, '02-15', '03-10', 85),
  ('Március 15. – kokárda, huszárok, nemzeti ünnep', 'event', null, '03-08', '03-16', 100),
  ('Víz világnapja – a víz útja és értéke', 'event', null, '03-15', '03-24', 85),
  ('Húsvét – tojásfestés, locsolkodás és tavaszi népszokások', 'event', null, '03-25', '04-25', 95),
  ('Költészet napja – versek, mondókák, verselés', 'event', null, '04-05', '04-13', 80),
  ('Föld napja – környezetvédelem és szelektív hulladékgyűjtés', 'event', null, '04-15', '04-24', 90),
  ('Anyák napja – ajándék és köszöntő az anyukáknak', 'event', null, '04-24', '05-08', 100),
  ('Madarak és fák napja – madárodú és faültetés', 'event', null, '05-03', '05-12', 85),
  ('Gyereknap – játékos nap a gyerekeknek', 'event', null, '05-18', '06-01', 90),
  ('Pünkösd – pünkösdi király és rózsa', 'event', null, '05-15', '06-12', 80),
  ('Évzáró és ballagás – búcsú az óvodától', 'event', null, '05-25', '06-20', 95),
  ('Nyári vizes és kerti játékok', 'event', null, '06-15', '08-15', 80),
  ('Augusztus 20. – új kenyér, államalapítás ünnepe', 'event', null, '08-10', '08-21', 100),
  ('Óvodakezdés és beszoktatás – ismerkedés, jelek, csoportszabályok', 'event', null, '08-25', '09-20', 95),
  ('Népmese napja – mesék és mesehősök', 'event', null, '09-22', '10-02', 90),
  ('Állatok világnapja – háziállatok és gondoskodás', 'event', null, '09-28', '10-08', 90),
  ('Szüret – szőlő, must és őszi betakarítás', 'event', null, '09-15', '10-20', 90),
  ('Őszi tökös hét – tökfaragás és Halloween', 'event', null, '10-22', '11-02', 80),
  ('Márton-nap – libás népszokások és lámpáskészítés', 'event', null, '10-28', '11-14', 100),
  -- Évszakos általános témák
  ('Őszi falevelek gyűjtése és préselése', 'season', 'osz', null, null, 50),
  ('Gesztenye, dió és makk – őszi termések', 'season', 'osz', null, null, 50),
  ('Az erdő ősszel – az állatok téli felkészülése', 'season', 'osz', null, null, 48),
  ('Őszi gyümölcsök és zöldségek', 'season', 'osz', null, null, 46),
  ('Vándormadarak búcsúja', 'season', 'osz', null, null, 45),
  ('Szél, eső, köd – az őszi időjárás', 'season', 'osz', null, null, 44),
  ('Őszi öltözködés – ruhák és cipők', 'season', 'osz', null, null, 42),
  ('A kert ősszel – betakarítás és komposztálás', 'season', 'osz', null, null, 42),
  ('A süni készül a télre', 'season', 'osz', null, null, 40),
  ('Gombák az erdőben – ehető és mérgező', 'season', 'osz', null, null, 40),
  ('Hóember építés és téli játékok', 'season', 'tel', null, null, 50),
  ('Madáretetés – madarak a hidegben', 'season', 'tel', null, null, 50),
  ('Jégvirág és hópehely – a tél csodái', 'season', 'tel', null, null, 48),
  ('Téli ruházat és öltözködés', 'season', 'tel', null, null, 46),
  ('Erdei állatok télen', 'season', 'tel', null, null, 46),
  ('Téli sportok – szánkózás és korcsolyázás', 'season', 'tel', null, null, 44),
  ('Egészség télen – teák, vitaminok, kézmosás', 'season', 'tel', null, null, 42),
  ('A fenyőfa és az örökzöldek', 'season', 'tel', null, null, 42),
  ('Hó és jég kísérletek', 'season', 'tel', null, null, 42),
  ('A tél a népi hagyományokban – mondókák és dalok', 'season', 'tel', null, null, 40),
  ('Tavaszi virágok – hóvirág, ibolya, tulipán', 'season', 'tavasz', null, null, 50),
  ('Ébredő természet – rügyfakadás', 'season', 'tavasz', null, null, 50),
  ('Visszatérő madarak – gólya és fecske', 'season', 'tavasz', null, null, 48),
  ('Magvetés és palántanevelés a kertben', 'season', 'tavasz', null, null, 48),
  ('Tavaszi esők – a víz körforgása', 'season', 'tavasz', null, null, 46),
  ('Bogarak, hernyók és pillangók', 'season', 'tavasz', null, null, 46),
  ('Virágzó gyümölcsfák és a méhek', 'season', 'tavasz', null, null, 44),
  ('Tavaszi nagytakarítás – rend és tisztaság', 'season', 'tavasz', null, null, 42),
  ('Tavaszi időjárás és öltözködés', 'season', 'tavasz', null, null, 40),
  ('Gyógy- és fűszernövények ültetése', 'season', 'tavasz', null, null, 40),
  ('Nyári gyümölcsök – eper, cseresznye, meggy', 'season', 'nyar', null, null, 50),
  ('Vízparti élet – tó, folyó, tenger', 'season', 'nyar', null, null, 50),
  ('Rovarok és méhek a réten', 'season', 'nyar', null, null, 48),
  ('Nyári zivatar és szivárvány', 'season', 'nyar', null, null, 46),
  ('Napvédelem és vízivás – egészséges nyár', 'season', 'nyar', null, null, 46),
  ('Kertészkedés – virágok locsolása és gondozása', 'season', 'nyar', null, null, 44),
  ('Búzaaratás és a kenyér útja', 'season', 'nyar', null, null, 44),
  ('Kirándulás és piknik a természetben', 'season', 'nyar', null, null, 42),
  ('Nyári mozgásos játékok a szabadban', 'season', 'nyar', null, null, 42),
  ('Vakáció – utazás és tengerpart', 'season', 'nyar', null, null, 40),
  -- Általános tartalék
  ('Közlekedés – gyalogosként és járművön', 'general', null, null, null, 20),
  ('Egészséges életmód – mozgás és táplálkozás', 'general', null, null, null, 20),
  ('Család – rokonok és otthon', 'general', null, null, null, 20),
  ('Foglalkozások – ki mit dolgozik', 'general', null, null, null, 20),
  ('Barátság – együtt játszunk', 'general', null, null, null, 20),
  ('Háziállatok és kicsinyeik', 'general', null, null, null, 20),
  ('Érzékszerveink – látás, hallás, tapintás', 'general', null, null, null, 20)
on conflict (title) do nothing;

-- >>>>>>>>>> 20261206150000_theme_suggestions_usage.sql
-- Téma-ajánló használati statisztika: hányszor indult generálás az adott ajánlott témával.
-- Idempotens: bármennyiszer újrafuttatható. Az Admin „Téma-ajánlók” fül ez alapján rendezi a legnépszerűbbeket előre.

alter table public.theme_suggestions
  add column if not exists usage_count integer not null default 0;

-- Atomikus növelés: id szerint, annak hiányában a trimmelt, kis- és nagybetűre érzéketlen cím szerint (egyetlen sort léptet).
-- Visszatérés: a módosított sorok száma (0 = nincs ilyen téma, pl. kézzel írt cím).
create or replace function public.increment_theme_suggestion_usage(p_id uuid default null, p_title text default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected integer := 0;
begin
  if p_id is not null then
    update public.theme_suggestions
       set usage_count = usage_count + 1
     where id = p_id;
  elsif nullif(btrim(coalesce(p_title, '')), '') is not null then
    update public.theme_suggestions
       set usage_count = usage_count + 1
     where id = (
       select t.id
         from public.theme_suggestions t
        where lower(btrim(t.title)) = lower(btrim(p_title))
        order by t.created_at, t.id
        limit 1
     );
  end if;
  get diagnostics affected = row_count;
  return affected;
end;
$$;

-- Csak a backend (service_role) hívhatja: a böngészőből nem lehet a számlálót tekerni.
revoke execute on function public.increment_theme_suggestion_usage(uuid, text) from public, anon, authenticated;
grant execute on function public.increment_theme_suggestion_usage(uuid, text) to service_role;
