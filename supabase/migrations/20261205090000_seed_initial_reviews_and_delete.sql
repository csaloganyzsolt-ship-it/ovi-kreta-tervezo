-- A főoldalon eddig beégetett 6 vélemény átemelése a `reviews` táblába (jóváhagyott állapotban), szerepkör-megjelöléssel.
-- Idempotens: a beszúrás a helyőrző e-mail cím alapján csak egyszer fut le. Figyelem: ha egy átemelt véleményt az Adminban
-- törölsz, a migráció újrafuttatása (pl. a RUN_ALL_PENDING_MIGRATIONS.sql) újra beszúrná.

alter table public.reviews add column if not exists role_label text;

-- A publikus olvasás kiegészül a szerepkör-megjelöléssel (az e-mail és az admin jegyzet továbbra sem olvasható).
grant select (role_label) on public.reviews to anon, authenticated;

insert into public.reviews (customer_name, customer_email, role_label, plan_topic, rating, comment, status, created_at)
select v.name, v.email, v.role_label, '', 5, v.comment, 'approved', now() - make_interval(days => v.days)
from (values
  ('Kovácsné T. Judit', 'korabbi-velemeny-1@ovitervezo.invalid', 'Óvodapedagógus (vegyes csoport)', 14,
   $q$Vasárnap esténként eddig órákat ültem a gép előtt a heti terv miatt. Tegnap kipróbáltam, 10 perc alatt meglett az alap, csak kicsit átírtam a saját csoportomra. Nagyon nagy segítség!$q$),
  ('Szabó Eszter', 'korabbi-velemeny-2@ovitervezo.invalid', 'Óvónő', 21,
   $q$Nem gondoltam volna hogy ilyen jol osszerakja a differenciálást a kicsikre meg a nagyokra is külön. A verseket meg meséket azért átnéztem benne, de rengeteg időt megspórolt.$q$),
  ('Varga-Németh Krisztina', 'korabbi-velemeny-3@ovitervezo.invalid', 'Óvodapedagógus', 32,
   $q$Kicsit szkeptikus voltam az AI-al kapcsolatban, de kolléganőm ajánlotta. A szülői előtt kellett gyorsan egy őszi projektterv, teljesen vállalható szakmai nyelvezetet használ.$q$),
  ('Tóth Anikó', 'korabbi-velemeny-4@ovitervezo.invalid', 'Óvodapedagógus (kiscsoport)', 35,
   $q$Szuper lett a letölthető word doksi, egyből tudtam szerkeszteni. Nekem a vizuális nevelés ötletek tetszettek a legjobban benne, végre nem ugyanazt a sablont kell elővenni.$q$),
  ('Horváthné Gabi', 'korabbi-velemeny-5@ovitervezo.invalid', 'Óvónő', 40,
   $q$Péntek délután mentett meg, mikor kiderült hogy hétfőn jön a szaktanácsadó és még nem volt kész a részletes tervezetem. Köszönöm!!$q$),
  ('Molnár Dóra', 'korabbi-velemeny-6@ovitervezo.invalid', 'Pályakezdő óvodapedagógus', 62,
   $q$Pályakezdőként néha még nehéz jól megfogalmazni a fejlesztési célokat. Ebből nagyon sokat tanulni, és nem sablonos mondatokat ír.$q$)
) as v(name, email, role_label, days, comment)
where not exists (select 1 from public.reviews r where r.customer_email = v.email);
