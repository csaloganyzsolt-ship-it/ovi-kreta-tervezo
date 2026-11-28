-- Téma-ajánló adatbázis: a tervező „Projekt témája” chipjeit a kiválasztott dátum (vagy hét) alapján ez a tábla adja.
-- category: event = jeles nap / ünnepkör (start_mmdd–end_mmdd ablakkal, az évforduló feletti átnyúlás is megengedett, pl. 12-28 – 01-08),
--           season = évszakos általános téma, general = bármikor ajánlható tartalék. Magasabb priority = előrébb jelenik meg.
-- Idempotens: bármennyiszer újrafuttatható. A seed a title egyedisége miatt nem duplikál (on conflict do nothing).
-- Olvasás: csak az aktív sorok publikusak; írás kizárólag a backendnek (service_role, ami megkerüli az RLS-t).

create table if not exists public.theme_suggestions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  category text not null check (category in ('event', 'season', 'general')),
  season text check (season in ('tavasz', 'nyar', 'osz', 'tel')),
  start_mmdd text check (start_mmdd ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
  end_mmdd text check (end_mmdd ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
  priority integer not null default 50,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists theme_suggestions_title_key on public.theme_suggestions (title);
create index if not exists theme_suggestions_active_category_idx on public.theme_suggestions (is_active, category, priority desc);

alter table public.theme_suggestions enable row level security;

drop policy if exists "theme_suggestions_public_read_active" on public.theme_suggestions;
create policy "theme_suggestions_public_read_active" on public.theme_suggestions
  for select using (is_active = true);

insert into public.theme_suggestions (title, category, season, start_mmdd, end_mmdd, priority) values
  -- Jeles napok, ünnepkörök (1–2 héttel előtte és pár nappal utána)
  ('Karácsony – ajándékkészítés és ünnepi hagyományok', 'event', null, '12-14', '12-27', 100),
  ('Adventi készülődés – koszorúkészítés és gyertyagyújtás', 'event', null, '11-25', '12-22', 90),
  ('Mikulás – csizmák, versek és mondókák', 'event', null, '11-26', '12-08', 98),
  ('Luca-nap – lucabúza ültetése és népszokások', 'event', null, '12-06', '12-14', 85),
  ('Újév – téli köszöntők és jókívánságok', 'event', null, '12-28', '01-08', 85),
  ('Vízkereszt – háromkirályok és téli népszokások', 'event', null, '01-02', '01-10', 80),
  ('Medvenap – a kis medve téli álma', 'event', null, '01-27', '02-05', 80),
  ('Farsang – jelmezek, álarcok és mulatság', 'event', null, '01-25', '03-02', 95),
  ('Téltemetés – kiszebáb és tavaszvárás', 'event', null, '02-15', '03-10', 85),
  ('Március 15. – kokárda, huszárok, nemzeti ünnep', 'event', null, '03-08', '03-16', 100),
  ('Víz világnapja – a víz útja és értéke', 'event', null, '03-15', '03-24', 85),
  ('Húsvét – tojásfestés, locsolkodás és tavaszi népszokások', 'event', null, '03-25', '04-25', 95),
  ('Költészet napja – versek, mondókák, verselés', 'event', null, '04-05', '04-13', 80),
  ('Föld napja – környezetvédelem és szelektív hulladékgyűjtés', 'event', null, '04-15', '04-24', 90),
  ('Anyák napja – ajándék és köszöntő az anyukáknak', 'event', null, '04-24', '05-08', 100),
  ('Madarak és fák napja – madárodú és faültetés', 'event', null, '05-03', '05-12', 85),
  ('Gyereknap – játékos nap a gyerekeknek', 'event', null, '05-18', '06-01', 90),
  ('Pünkösd – pünkösdi király és rózsa', 'event', null, '05-15', '06-12', 80),
  ('Évzáró és ballagás – búcsú az óvodától', 'event', null, '05-25', '06-20', 95),
  ('Nyári vizes és kerti játékok', 'event', null, '06-15', '08-15', 80),
  ('Augusztus 20. – új kenyér, államalapítás ünnepe', 'event', null, '08-10', '08-21', 100),
  ('Óvodakezdés és beszoktatás – ismerkedés, jelek, csoportszabályok', 'event', null, '08-25', '09-20', 95),
  ('Népmese napja – mesék és mesehősök', 'event', null, '09-22', '10-02', 90),
  ('Állatok világnapja – háziállatok és gondoskodás', 'event', null, '09-28', '10-08', 90),
  ('Szüret – szőlő, must és őszi betakarítás', 'event', null, '09-15', '10-20', 90),
  ('Őszi tökös hét – tökfaragás és Halloween', 'event', null, '10-22', '11-02', 80),
  ('Márton-nap – libás népszokások és lámpáskészítés', 'event', null, '10-28', '11-14', 100),
  -- Évszakos általános témák
  ('Őszi falevelek gyűjtése és préselése', 'season', 'osz', null, null, 50),
  ('Gesztenye, dió és makk – őszi termések', 'season', 'osz', null, null, 50),
  ('Az erdő ősszel – az állatok téli felkészülése', 'season', 'osz', null, null, 48),
  ('Őszi gyümölcsök és zöldségek', 'season', 'osz', null, null, 46),
  ('Vándormadarak búcsúja', 'season', 'osz', null, null, 45),
  ('Szél, eső, köd – az őszi időjárás', 'season', 'osz', null, null, 44),
  ('Őszi öltözködés – ruhák és cipők', 'season', 'osz', null, null, 42),
  ('A kert ősszel – betakarítás és komposztálás', 'season', 'osz', null, null, 42),
  ('A süni készül a télre', 'season', 'osz', null, null, 40),
  ('Gombák az erdőben – ehető és mérgező', 'season', 'osz', null, null, 40),
  ('Hóember építés és téli játékok', 'season', 'tel', null, null, 50),
  ('Madáretetés – madarak a hidegben', 'season', 'tel', null, null, 50),
  ('Jégvirág és hópehely – a tél csodái', 'season', 'tel', null, null, 48),
  ('Téli ruházat és öltözködés', 'season', 'tel', null, null, 46),
  ('Erdei állatok télen', 'season', 'tel', null, null, 46),
  ('Téli sportok – szánkózás és korcsolyázás', 'season', 'tel', null, null, 44),
  ('Egészség télen – teák, vitaminok, kézmosás', 'season', 'tel', null, null, 42),
  ('A fenyőfa és az örökzöldek', 'season', 'tel', null, null, 42),
  ('Hó és jég kísérletek', 'season', 'tel', null, null, 42),
  ('A tél a népi hagyományokban – mondókák és dalok', 'season', 'tel', null, null, 40),
  ('Tavaszi virágok – hóvirág, ibolya, tulipán', 'season', 'tavasz', null, null, 50),
  ('Ébredő természet – rügyfakadás', 'season', 'tavasz', null, null, 50),
  ('Visszatérő madarak – gólya és fecske', 'season', 'tavasz', null, null, 48),
  ('Magvetés és palántanevelés a kertben', 'season', 'tavasz', null, null, 48),
  ('Tavaszi esők – a víz körforgása', 'season', 'tavasz', null, null, 46),
  ('Bogarak, hernyók és pillangók', 'season', 'tavasz', null, null, 46),
  ('Virágzó gyümölcsfák és a méhek', 'season', 'tavasz', null, null, 44),
  ('Tavaszi nagytakarítás – rend és tisztaság', 'season', 'tavasz', null, null, 42),
  ('Tavaszi időjárás és öltözködés', 'season', 'tavasz', null, null, 40),
  ('Gyógy- és fűszernövények ültetése', 'season', 'tavasz', null, null, 40),
  ('Nyári gyümölcsök – eper, cseresznye, meggy', 'season', 'nyar', null, null, 50),
  ('Vízparti élet – tó, folyó, tenger', 'season', 'nyar', null, null, 50),
  ('Rovarok és méhek a réten', 'season', 'nyar', null, null, 48),
  ('Nyári zivatar és szivárvány', 'season', 'nyar', null, null, 46),
  ('Napvédelem és vízivás – egészséges nyár', 'season', 'nyar', null, null, 46),
  ('Kertészkedés – virágok locsolása és gondozása', 'season', 'nyar', null, null, 44),
  ('Búzaaratás és a kenyér útja', 'season', 'nyar', null, null, 44),
  ('Kirándulás és piknik a természetben', 'season', 'nyar', null, null, 42),
  ('Nyári mozgásos játékok a szabadban', 'season', 'nyar', null, null, 42),
  ('Vakáció – utazás és tengerpart', 'season', 'nyar', null, null, 40),
  -- Általános tartalék
  ('Közlekedés – gyalogosként és járművön', 'general', null, null, null, 20),
  ('Egészséges életmód – mozgás és táplálkozás', 'general', null, null, null, 20),
  ('Család – rokonok és otthon', 'general', null, null, null, 20),
  ('Foglalkozások – ki mit dolgozik', 'general', null, null, null, 20),
  ('Barátság – együtt játszunk', 'general', null, null, null, 20),
  ('Háziállatok és kicsinyeik', 'general', null, null, null, 20),
  ('Érzékszerveink – látás, hallás, tapintás', 'general', null, null, null, 20)
on conflict (title) do nothing;
