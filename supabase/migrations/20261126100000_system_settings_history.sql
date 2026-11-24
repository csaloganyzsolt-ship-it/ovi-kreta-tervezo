-- Rendszerbeállítások naplózása: minden értékváltozás (UPDATE) automatikusan bekerül a history táblába.
-- Csak a backend (service_role) fér hozzá; a visszaállítás kézzel, a régi érték visszamásolásával történik.

create table if not exists public.system_settings_history (
  id uuid primary key default gen_random_uuid(),
  setting_key text not null,
  old_value jsonb,
  new_value jsonb,
  changed_at timestamptz not null default now()
);

create index if not exists system_settings_history_key_changed_idx
  on public.system_settings_history (setting_key, changed_at desc);

alter table public.system_settings_history enable row level security;

drop policy if exists "system_settings_history_no_access" on public.system_settings_history;
create policy "system_settings_history_no_access" on public.system_settings_history
  for all using (false) with check (false);

revoke all on public.system_settings_history from anon, authenticated;
grant select on public.system_settings_history to service_role;

create or replace function public.log_system_settings_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.value is distinct from old.value then
    insert into public.system_settings_history (setting_key, old_value, new_value)
    values (old.key, old.value, new.value);
  end if;
  return new;
end;
$$;

revoke all on function public.log_system_settings_change() from public;

drop trigger if exists system_settings_history_trigger on public.system_settings;
create trigger system_settings_history_trigger
  after update on public.system_settings
  for each row execute function public.log_system_settings_change();
