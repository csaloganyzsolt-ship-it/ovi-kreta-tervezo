-- Külön számlázási/rendelési és hiba-/tesztelési/visszajelzési értesítési e-mail cím.
-- A seed sorok miatt az első mentés UPDATE, így a system_settings_history trigger naplózza.
insert into public.system_settings (key, value) values
  ('billing_notification_email', '""'::jsonb),
  ('error_notification_email', '""'::jsonb)
on conflict (key) do nothing;
