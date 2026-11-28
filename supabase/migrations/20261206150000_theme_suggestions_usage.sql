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
