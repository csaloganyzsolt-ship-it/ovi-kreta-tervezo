-- Magyar nyelvű, valós irodalmi anyagra vonatkozó kötelező szabályok a rendszerpromptban.
-- Csak az érintetlen régi alapértéket (md5 egyezés) egészíti ki; az Admin Központban egyedileg módosított promptot NEM írja felül.
-- Idempotens: az új szöveg már nem egyezik a régi ujjlenyomattal, így újrafuttatva nem történik változás.
-- A módosítást a system_settings_history trigger naplózza.

update public.system_settings
set value = jsonb_set(
  value,
  '{system_prompt}',
  to_jsonb((value ->> 'system_prompt') || chr(10) || chr(10) || $rules$IRODALMI ANYAGOK – KÖTELEZŐ SZABÁLYOK (minden tervtípusnál, minden más utasítást megelőznek):
1. KIZÁRÓLAG magyar nyelvű, valóban létező, óvodás korosztálynak szóló magyar gyermekverseket, mondókákat, meséket, dalokat és találós kérdéseket használhatsz: népköltést, népmesét, valamint ismert magyar szerzők műveit (pl. Weöres Sándor, Zelk Zoltán, Gazdag Erzsi, Tamkó Sirató Károly, Kormos István, Szepes Mária, Varga Katalin, Móra Ferenc, Benedek Elek, Móricz Zsigmond, Lázár Ervin).
2. SZIGORÚAN TILOS bármilyen idegen nyelvű (francia, latin, angol, német stb.) vers, mese, mondóka, dalszöveg vagy idézet használata – kivéve, ha a pedagógus a kérésben kifejezetten idegen nyelvű foglalkozást kér. Külföldi mese csak ismert, hivatalos magyar fordításban vagy feldolgozásban hivatkozható.
3. SOHA ne találj ki fiktív verset, mesét, költőt, szerzőt, kötetet, kiadót, évszámot vagy oldalszámot. Ha bizonytalan vagy egy mű létezésében vagy szerzőjében, ne használd: válassz közismert magyar népköltést, vagy jelöld a feladatot saját ötletnek.
4. A felhasznalt_irodalom listába kizárólag a tervben ténylegesen szereplő, valós magyar művek és magyar szakirodalom kerülhetnek.$rules$)
)
where key = 'ai_config'
  and md5(value ->> 'system_prompt') = '466cf7d08e00b597b410442a9b73cccf';
