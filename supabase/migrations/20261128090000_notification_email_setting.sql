-- Üzemeltetői / értesítési e-mail cím az Admin Központból (üres: a Render környezeti változói a tartalék).
-- A meglévő érték nem íródik felül; a módosításokat a system_settings_history trigger naplózza.
insert into public.system_settings (key, value) values
  ('notification_email', '""'::jsonb)
on conflict (key) do nothing;
