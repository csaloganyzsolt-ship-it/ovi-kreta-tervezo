-- A kézbesítő levél tárgyából kikerül az „e-számla” kifejezés (papíralapú PDF számlát küldünk).
-- Csak az érintetlen régi alaptárgyat írja át, az egyedi admin módosítást nem bántja; többször is futtatható.
update public.email_templates
set subject = 'OviTervező – a megvásárolt tervezet és a számla'
where id = 'payment_success'
  and subject = 'OviTervező – a megvásárolt tervezet és az e-számla';
