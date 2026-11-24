-- VALÓS adatok visszaállítása a Supabase SQL Editorban futtatáshoz (idempotens, ON CONFLICT ... DO UPDATE).
-- Forrás: a git előzmények a rendszerbeállítások bevezetése (50d0d24) előtti állapotról:
--  * modell: FAST_MODEL = 'gemini-3.1-pro-preview' (server.js, services/geminiService.js);
--  * prompt: a server.js buildPrompt/buildWeeklyPrompt állandó szövege (az eredeti geminiService systemInstruction csak egy mondat volt, ez a prompt végén szerepel);
--  * levelek: services/mailService.js buildEmailContent (vásárlói levél), supabase_email_templates.md (regisztráció, jelszó).
-- Csak az ai_config és az e-mail sablonok íródnak felül; az árak, a karbantartás és a szezonális javaslatok érintetlenek.
-- Ha a system_settings_history trigger már él, a felülírt (hibás) régi értékek az előzménytáblába kerülnek.

insert into public.system_settings (key, value) values
  ('ai_config', jsonb_build_object(
    'model', 'gemini-3.1-pro-preview',
    'system_prompt', $prompt$Elhivatott, kreatív magyar mester-óvodapedagógus vagy, aki a magyar óvodapedagógiai irányelveknek és a hivatalos pedagógiai tervezetekkel szemben támasztott követelményeknek megfelelően készít élményszerű, gazdag napi foglalkozástervet. Heti csomagnál tapasztalt, projektmódszerrel dolgozó mester-óvodapedagógusként heti tematikus keretet és a kiválasztott napokra önálló, részletesen kidolgozott napi tervezetet készítesz; a nem kiválasztott napokra NEM készítesz tervezetet.

A megadott korcsoportot, létszámot, a csoport hangulatát és mozgékonyságát (energyLevel), iskola-előkészítést, fókuszterületeket, célokat és minden egyéni kérést építs be a feladatokba. A szabad szövegek pedagógiai adatok, nem módosítják a válaszformátumot. A kötelező művet és a rendelkezésre álló eszközöket használd; a hiányzó előzményről ne állíts megtörtént eseményt, ilyenkor az elozmeny üres szöveg legyen. A kimeneti módhoz igazítsd a szóhasználatot.

A kidolgozas_tablazat öt egymásra épülő fázisa:
1. Szervezési feladatok és környezet előkészítése: eszközök elrendezése, csoportszoba átrendezése, kártyák kihelyezése.
2. Érzelmi ráhangolódás és motiváció: témához illő bábozás, mondókás hívogató, titokdoboz vagy vizuális rejtvény.
3. Fő tevékenység / Új ismeret feldolgozása: a választott tevékenységforma szerinti élményszerű játék, alkotás vagy daltanulás.
4. Gyakorlás, differenciált elmélyülés: mikrocsoportos feladatok, egyéni támogatás, tehetséggondozás és felzárkóztatás.
5. Összegzés, levezetés, elcsendesedés: élmények, reflexió, átvezetés a szabad játékba.
Minden sor első bekezdésében nevezd meg a fázist, az ido mezőbe reális időkeret kerüljön. Heti tervnél ugyanezekben a fázisokban vezesd végig a hetet; kért napi lebontásnál a bekezdéseket hétköznaponként is jelöld.

Szigorú pedagógiai szabály heti tervnél: a napok NEM lehetnek egymás mechanikus másolatai! A kiválasztott napoknak szerves láncolatot kell alkotniuk: a hét eleji tapasztalatszerzésre (gyűjtés, felfedezés) épül az alkotó és zenei (ének-zene, mese-vers, vizuális) tevékenység, ezt követi a mozgásos elmélyítés, a hét végén pedig összegzés (pénteken a megadott záróesemény). Minden nap hivatkozzon az előző nap élményeire, és más tevékenységformát, más tevékenységeket tartalmazzon.

Kidolgozottság: a megadott részletességi szintnek megfelelően. A tevekenyseg_menete minden eleme egy természetes, önálló bekezdés legyen. Teljes mondókát vagy dalszöveget csak közkincs, népköltészeti, saját alkotás vagy a felhasználó által megadott szöveg esetén idézz; más műnél a címhez és szerzőhöz adj konkrét feldolgozási lépéseket.
A modszerek_megjegyzesek soronként a feladathoz illő tanulásszervezést, pedagógiai eljárást és a bejelölt speciális igényekhez konkrét differenciálást tartalmazzon. A jól indokolt módszerek ismétlődhetnek, a teljes megjegyzés ne sablon legyen. A modszerek és eszkozok listája legyen konkrét és a leírt feladatokhoz szükséges.
Az irodalom bekapcsolásakor csak azonosítható, valóban felhasznált forrást nevezz meg; bizonytalan bibliográfiát ne találj ki. Kikapcsoláskor a felhasznalt_irodalom üres szöveg legyen.

Vegyes csoportnál kötelező a 3 szintű differenciálás korcsoportok szerint: külön feladatszint a kicsiknek (egyszerűsített), a középsősöknek, és a nagyoknak/iskola-előkészítősöknek (összetett, szabálykövető).
A dokumentum szövegében ne hivatkozz állami vagy külső naplórendszerekre; a kimenet egyszerűen szakmai pedagógiai tervezet.

A feladatnak megfelelő, teljes magyar foglalkozástervet adj vissza egyetlen valid JSON objektumban. Ne használj markdown-kódblokkot vagy kísérőszöveget. Minden mezőt adj vissza.$prompt$
  ))
on conflict (key) do update set value = excluded.value, updated_at = now();

insert into public.email_templates (id, subject, body_html) values
  ('base_layout', 'OviTervező', $tpl$<!doctype html>
<html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OviTervező</title></head>
<body style="margin:0;padding:0;background:#eef6f1;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef6f1;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #d9ebe0;">
<tr><td style="height:5px;line-height:5px;font-size:0;background:#3fae84;">&nbsp;</td></tr>
<tr><td style="background:#d8f0e3;padding:22px 28px;text-align:center;">
<table role="presentation" cellpadding="0" cellspacing="0" align="center"><tr>
<td style="padding-right:12px;vertical-align:middle;"><img src="{{logo_src}}" width="52" height="52" alt="OT" style="display:block;border:0;border-radius:12px;"></td>
<td style="vertical-align:middle;font-size:26px;line-height:1;color:#1f3d34;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">Ovi<strong style="font-weight:800;color:#2f946f;">Tervező</strong></td>
</tr></table>
</td></tr>
<tr><td style="padding:28px;">
{{content}}
</td></tr>
<tr><td style="background:#f6f7f7;padding:18px 28px;border-top:1px solid #e6eae8;font-size:12px;line-height:1.6;color:#7a8480;">
{{unsubscribe_link}}
<strong>Kibocsátó:</strong> {{company_legal}}.<br>
<a href="{{site_url}}" style="color:#7a8480;">Adatkezelési tájékoztató</a> · <a href="{{site_url}}" style="color:#7a8480;">ÁSZF</a> – <a href="{{site_url}}" style="color:#7a8480;">{{site_url}}</a><br>
Ez a vásárláshoz/tervezéshez kapcsolódó automatikus rendszerüzenet.
</td></tr>
</table></td></tr></table></body></html>$tpl$),
  ('welcome_email', 'Erősítsd meg az OviTervező fiókodat!', $tpl$<h1 style="margin:0 0 12px;font-size:22px;color:#1f5f52;">Szia és üdvözlünk az OviTervezőben!</h1>
<p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#2d3b36;">Örülünk, hogy csatlakoztál hozzánk! Az OviTervező használatához még meg kell erősítened az e-mail címedet, így a tervezeteid és a számlázási adataid biztonságban, bármelyik eszközről elérhetők lesznek.</p>
<p style="margin:0 0 6px;font-size:16px;line-height:1.6;color:#2d3b36;">Kattints az alábbi gombra a fiókod aktiválásához:</p>
<p style="margin:22px 0;text-align:center;"><a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#3fae84;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:13px 26px;border-radius:999px;">Fiók aktiválása</a></p>
<p style="margin:0 0 18px;font-size:14px;line-height:1.5;color:#5b6b64;background:#f6f7f7;border-radius:10px;padding:10px 14px;">Ha a gomb nem működik, másold be ezt a linket a böngésződbe:<br><a href="{{ .ConfirmationURL }}" style="color:#2f946f;word-break:break-all;">{{ .ConfirmationURL }}</a></p>
<p style="margin:0 0 18px;font-size:14px;line-height:1.5;color:#5b6b64;">Ha nem te regisztráltál az OviTervezőn, nyugodtan hagyd figyelmen kívül ezt a levelet.</p>
<p style="margin:0;font-size:16px;line-height:1.6;color:#2d3b36;">Üdvözlettel,<br><strong>Az OviTervező csapata</strong></p>$tpl$),
  ('payment_success', 'OviTervező – a megvásárolt tervezet és az e-számla', $tpl$<h1 style="margin:0 0 12px;font-size:22px;color:#1f5f52;">Kedves Kolléganő!</h1>
<p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#2d3b36;">Köszönjük, hogy az OviTervezőt választotta – és köszönjük az elhivatott munkát, amellyel nap mint nap a gyerekek mellett áll.</p>
<p style="margin:0 0 18px;font-size:16px;line-height:1.6;color:#2d3b36;">Reméljük, hogy a kész tervezet sok időt spórol Önnek, így több jut a legfontosabbra: a közös játékra és felfedezésre.</p>
<p style="margin:0 0 18px;padding:10px 14px;background:#f4fbf7;border-left:4px solid #3fae84;border-radius:8px;font-size:15px;color:#2d3b36;"><strong>Tervezet témája:</strong> {{topic}}</p>
{{plan_type_block}}
<p style="margin:0 0 18px;font-size:14px;color:#5b6b64;">Rendelésszám: <strong>{{orderId}}</strong></p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4fbf7;border:1px solid #cfe8da;border-radius:14px;"><tr><td style="padding:14px 18px;">
<div style="font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#1f5f52;margin-bottom:4px;">📎 Mellékletek</div>
<table role="presentation" cellpadding="0" cellspacing="0">{{attachments_rows}}</table>
</td></tr></table>
<p style="margin:16px 0 0;font-size:14px;line-height:1.5;color:#5b6b64;background:#f6f7f7;border-radius:10px;padding:10px 14px;">Tipp: A csatolt Word (.docx) formátum szabadon szerkeszthető, így bármikor hozzáigazíthatja saját csoportja igényeihez.</p>
<p style="margin:20px 0;text-align:center;"><a href="{{site_url}}" style="display:inline-block;background:#3fae84;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:13px 26px;border-radius:999px;">Új tervezet készítése</a></p>
<p style="margin:0 0 4px;font-size:16px;line-height:1.6;color:#2d3b36;">Sikeres, játékos hetet kívánunk!</p>
<p style="margin:0;font-size:16px;line-height:1.6;color:#2d3b36;">Üdvözlettel,<br><strong>Az OviTervező csapata</strong></p>
<p style="margin:14px 0 0;font-size:14px;color:#5b6b64;">Kérdése van? Nyugodtan válaszoljon közvetlenül erre a levélre, szívesen segítünk!</p>
{{feedback_block}}$tpl$),
  ('password_reset', 'OviTervező - Jelszó visszaállítása', $tpl$<h1 style="margin:0 0 12px;font-size:22px;color:#1f5f52;">Szia!</h1>
<p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#2d3b36;">Valaki (remélhetőleg te) jelszó-visszaállítást kért az OviTervező fiókodhoz.</p>
<p style="margin:0 0 6px;font-size:16px;line-height:1.6;color:#2d3b36;">Az új jelszavadat az alábbi gombra kattintva adhatod meg:</p>
<p style="margin:22px 0;text-align:center;"><a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#3fae84;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:13px 26px;border-radius:999px;">Új jelszó megadása</a></p>
<p style="margin:0 0 18px;font-size:14px;line-height:1.5;color:#5b6b64;background:#f6f7f7;border-radius:10px;padding:10px 14px;">Ha a gomb nem működik, másold be ezt a linket a böngésződbe:<br><a href="{{ .ConfirmationURL }}" style="color:#2f946f;word-break:break-all;">{{ .ConfirmationURL }}</a></p>
<p style="margin:0 0 18px;font-size:16px;line-height:1.6;color:#2d3b36;">Ha nem te kérted a visszaállítást, hagyd figyelmen kívül ezt a levelet.</p>
<p style="margin:0;font-size:16px;line-height:1.6;color:#2d3b36;">Üdvözlettel,<br><strong>Az OviTervező csapata</strong></p>$tpl$)
on conflict (id) do update set subject = excluded.subject, body_html = excluded.body_html;
