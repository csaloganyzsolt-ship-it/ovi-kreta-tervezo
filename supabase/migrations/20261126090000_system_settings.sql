-- Rendszerbeállítások és e-mail sablonok: az árak, az AI-konfiguráció, a karbantartás mód, a szezonális javaslatok és a levélsablonok adatbázisból jönnek.
-- Csak a backend (service_role) fér hozzá; a nyilvános adatot a GET /api/config adja ki.

create table if not exists public.system_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.email_templates (
  id text primary key,
  subject text not null default '',
  body_html text not null default ''
);

alter table public.system_settings enable row level security;
alter table public.email_templates enable row level security;

drop policy if exists "system_settings_no_access" on public.system_settings;
create policy "system_settings_no_access" on public.system_settings
  for all using (false) with check (false);

drop policy if exists "email_templates_no_access" on public.email_templates;
create policy "email_templates_no_access" on public.email_templates
  for all using (false) with check (false);

revoke all on public.system_settings from anon, authenticated;
revoke all on public.email_templates from anon, authenticated;
grant select, insert, update on public.system_settings to service_role;
grant select, insert, update on public.email_templates to service_role;

insert into public.system_settings (key, value) values
  ('pricing', '{"standard": 390, "academic": 690, "weekly": 890}'::jsonb),
  ('ai_config', jsonb_build_object(
    'model', 'gpt-4o-mini',
    'system_prompt', 'Te egy 20 éves tapasztalattal rendelkező, kedves magyar óvodapedagógus vagy, aki életszerű, differenciált, a magyar óvodai nevelés országos alapprogramjához igazodó foglalkozásterveket készít.'
  )),
  ('maintenance_mode', 'false'::jsonb),
  ('seasonal_hints', '["őszi falevelek gyűjtése", "Márton-napi lámpáskészítés", "farsangi mulatság"]'::jsonb)
on conflict (key) do update set value = excluded.value, updated_at = now();

-- A base_layout a közös keret: a {{content}} helyére kerül a többi sablon tartalma.
insert into public.email_templates (id, subject, body_html) values
  ('base_layout', 'OviTervező', '<!doctype html>
<html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OviTervező</title></head>
<body style="margin:0;padding:0;background:#eef6f1;font-family:''Segoe UI'',Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef6f1;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #d9ebe0;">
<tr><td style="height:5px;line-height:5px;font-size:0;background:#3fae84;">&nbsp;</td></tr>
<tr><td style="background:#d8f0e3;padding:22px 28px;text-align:center;font-size:26px;line-height:1;color:#1f3d34;">Ovi<strong style="font-weight:800;color:#2f946f;">Tervező</strong></td></tr>
<tr><td style="padding:28px;">{{content}}</td></tr>
<tr><td style="background:#f6f7f7;padding:18px 28px;border-top:1px solid #e6eae8;font-size:12px;line-height:1.6;color:#7a8480;">Ez az OviTervező automatikus rendszerüzenete. Kérdés esetén válaszolj erre a levélre. – https://ovitervezo.hu</td></tr>
</table></td></tr></table></body></html>'),
  ('welcome_email', 'Üdvözlünk az OviTervezőben!', '<h1 style="margin:0 0 12px;font-size:22px;color:#1f5f52;">Kedves Kolléganő!</h1>
<p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#2d3b36;">Örülünk, hogy csatlakoztál az OviTervezőhöz. Néhány perc alatt szakszerű, szerkeszthető óvodai tervezetet készíthetsz.</p>
<p style="margin:20px 0;text-align:center;"><a href="https://ovitervezo.hu/tervezo.html" style="display:inline-block;background:#3fae84;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:13px 26px;border-radius:999px;">Új tervezet készítése</a></p>'),
  ('payment_success', 'OviTervező – a megvásárolt tervezet és az e-számla', '<h1 style="margin:0 0 12px;font-size:22px;color:#1f5f52;">Köszönjük a vásárlást!</h1>
<p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#2d3b36;">A megvásárolt tervezetet ({{planLabel}}) mellékletben küldjük.{{invoiceText}}</p>
{{title_block}}{{order_block}}
<p style="margin:20px 0;text-align:center;"><a href="https://ovitervezo.hu/tervezo.html" style="display:inline-block;background:#3fae84;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:13px 26px;border-radius:999px;">Új tervezet készítése</a></p>
<p style="margin:0;font-size:16px;line-height:1.6;color:#2d3b36;">Üdvözlettel,<br><strong>Az OviTervező csapata</strong></p>'),
  ('password_reset', 'OviTervező – jelszó visszaállítása', '<h1 style="margin:0 0 12px;font-size:22px;color:#1f5f52;">Jelszó visszaállítása</h1>
<p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#2d3b36;">Jelszó-visszaállítást kértél az OviTervező fiókodhoz. Az alábbi gombbal adhatsz meg új jelszót.</p>
<p style="margin:20px 0;text-align:center;"><a href="{{action_url}}" style="display:inline-block;background:#3fae84;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:13px 26px;border-radius:999px;">Új jelszó megadása</a></p>
<p style="margin:0;font-size:14px;color:#5b6b64;">Ha nem te kérted, nyugodtan hagyd figyelmen kívül ezt a levelet.</p>')
on conflict (id) do update set subject = excluded.subject, body_html = excluded.body_html;
