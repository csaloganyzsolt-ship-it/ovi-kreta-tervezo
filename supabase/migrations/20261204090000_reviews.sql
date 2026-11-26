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
