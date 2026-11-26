-- Beállítás-változások auditnaplója: ki, mikor, mit módosított (régi érték -> új érték).
-- A backend a módosító admin e-mail címét az updated_by oszlopba írja; a trigger ebből tölti a history.changed_by mezőt.
-- Az e-mail sablonok módosítását a backend közvetlenül naplózza (setting_key = 'email_template:<id>').

alter table public.system_settings add column if not exists updated_by text;
alter table public.system_settings_history add column if not exists changed_by text;

create index if not exists system_settings_history_changed_at_idx
  on public.system_settings_history (changed_at desc);

create or replace function public.log_system_settings_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.value is distinct from old.value then
    insert into public.system_settings_history (setting_key, old_value, new_value, changed_by)
    values (
      old.key,
      old.value,
      new.value,
      case when new.updated_at is distinct from old.updated_at then new.updated_by else null end
    );
  end if;
  return new;
end;
$$;

revoke all on function public.log_system_settings_change() from public;

drop trigger if exists system_settings_history_trigger on public.system_settings;
create trigger system_settings_history_trigger
  after update on public.system_settings
  for each row execute function public.log_system_settings_change();

-- Rendszernapló: gyors szűrés szint és kontextus szerint nagy adatmennyiségnél is.
create index if not exists system_logs_level_created_idx on public.system_logs (level, created_at desc);
create index if not exists system_logs_context_created_idx on public.system_logs (context, created_at desc);
