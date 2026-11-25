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
