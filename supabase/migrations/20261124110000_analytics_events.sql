-- Analytics Events tábla: 100%-ban anonim, GDPR-kompatibilis telemetria.
-- Tilos: IP-cím, user_id, böngésző-azonosító, sütik vagy más személyazonosító.
-- Engedélyezett: eseménynév, eszköztípus, referrer domain, névtelen metaadatok (plan_mode, age_group, theme_category, utm_source).

create table if not exists public.analytics_events (
  id uuid primary key default gen_random_uuid(),
  event_name text not null,
  category text,
  device_type text,
  referrer_domain text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Indexek teljesítményhez
create index if not exists idx_analytics_events_event_name on public.analytics_events (event_name);
create index if not exists idx_analytics_events_created_at on public.analytics_events (created_at desc);
create index if not exists idx_analytics_events_device_type on public.analytics_events (device_type);
create index if not exists idx_analytics_events_referrer on public.analytics_events (referrer_domain);

-- Row Level Security: csak a backend (service role) írhatja/olvashatja, auth/anon nem férhet hozzá
alter table public.analytics_events enable row level security;

-- Az összes hozzáférést megtagadjuk alapból
drop policy if exists "analytics_events_no_access" on public.analytics_events;
create policy "analytics_events_no_access" on public.analytics_events
  for all using (false) with check (false);

-- Service role (backend) számára: INSERT (naplózás) és SELECT (admin report) jogok
grant insert, select on public.analytics_events to service_role;
revoke all on public.analytics_events from anon, authenticated;

