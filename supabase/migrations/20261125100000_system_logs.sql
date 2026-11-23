-- Rendszernapló: a backend hibáit és fontos eseményeit gyűjti (AI generálás, Barion fizetés, e-mail küldés).
create table if not exists public.system_logs (
  id uuid primary key default gen_random_uuid(),
  level text not null check (level in ('info', 'warning', 'error')),
  context text not null,
  message text not null,
  details jsonb not null default '{}'::jsonb,
  user_email text,
  created_at timestamptz not null default now()
);

create index if not exists idx_system_logs_created_at on public.system_logs (created_at desc);
create index if not exists idx_system_logs_level on public.system_logs (level);

-- Csak a szerver (service role) írhatja és olvashatja; az anon és authenticated szerepkör semmit nem lát.
alter table public.system_logs enable row level security;

drop policy if exists "system_logs_no_access" on public.system_logs;
create policy "system_logs_no_access" on public.system_logs
  for all using (false) with check (false);

revoke all on public.system_logs from anon, authenticated;
grant insert, select on public.system_logs to service_role;
