# Supabase Auth e-mail sablonok (OviTervező)

Beillesztés: Supabase Dashboard → **Authentication** → **Emails** → **Templates**. Minden sablonnál a **Subject** mezőbe a megadott tárgy, a **Message body** (Source) mezőbe a HTML kód kerül.

A stílus megegyezik a vásárlói visszaigazoló levéllel (`services/mailService.js`): mentazöld (`#3fae84`) csík és gomb, pasztell menta fejléc, lekerekített kártya, `Segoe UI` betűtípus. A Supabase nem tud csatolt (CID) képet küldeni, ezért a logó itt színes "OT" jelvény, ami minden levelezőben egyformán jelenik meg. A Kibocsátó-lábléc szándékosan hiányzik, mert ezek rendszerüzenetek, nem vásárlási dokumentumok.

---

## 1. Confirm sign up (Regisztráció megerősítése)

**Subject:** `Erősítsd meg az OviTervező fiókodat!`

```html
<!doctype html>
<html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OviTervező</title></head>
<body style="margin:0;padding:0;background:#eef6f1;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef6f1;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #d9ebe0;">
<tr><td style="height:5px;line-height:5px;font-size:0;background:#3fae84;">&nbsp;</td></tr>
<tr><td style="background:#d8f0e3;padding:22px 28px;text-align:center;">
<table role="presentation" cellpadding="0" cellspacing="0" align="center"><tr>
<td style="padding-right:12px;vertical-align:middle;"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="52" height="52" align="center" valign="middle" style="width:52px;height:52px;background:#3fae84;border-radius:12px;color:#ffffff;font-size:22px;font-weight:800;line-height:52px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">OT</td></tr></table></td>
<td style="vertical-align:middle;font-size:26px;line-height:1;color:#1f3d34;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">Ovi<strong style="font-weight:800;color:#2f946f;">Tervező</strong></td>
</tr></table>
</td></tr>
<tr><td style="padding:28px;">
<h1 style="margin:0 0 12px;font-size:22px;color:#1f5f52;">Szia és üdvözlünk az OviTervezőben!</h1>
<p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#2d3b36;">Örülünk, hogy csatlakoztál hozzánk! Az OviTervező használatához még meg kell erősítened az e-mail címedet, így a tervezeteid és a számlázási adataid biztonságban, bármelyik eszközről elérhetők lesznek.</p>
<p style="margin:0 0 6px;font-size:16px;line-height:1.6;color:#2d3b36;">Kattints az alábbi gombra a fiókod aktiválásához:</p>
<p style="margin:22px 0;text-align:center;"><a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#3fae84;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:13px 26px;border-radius:999px;">Fiók aktiválása</a></p>
<p style="margin:0 0 18px;font-size:14px;line-height:1.5;color:#5b6b64;background:#f6f7f7;border-radius:10px;padding:10px 14px;">Ha a gomb nem működik, másold be ezt a linket a böngésződbe:<br><a href="{{ .ConfirmationURL }}" style="color:#2f946f;word-break:break-all;">{{ .ConfirmationURL }}</a></p>
<p style="margin:0 0 18px;font-size:14px;line-height:1.5;color:#5b6b64;">Ha nem te regisztráltál az OviTervezőn, nyugodtan hagyd figyelmen kívül ezt a levelet.</p>
<p style="margin:0;font-size:16px;line-height:1.6;color:#2d3b36;">Üdvözlettel,<br><strong>Az OviTervező csapata</strong></p>
</td></tr>
<tr><td style="background:#f6f7f7;padding:18px 28px;border-top:1px solid #e6eae8;font-size:12px;line-height:1.6;color:#7a8480;">
<a href="https://ovitervezo.hu" style="color:#7a8480;">ovitervezo.hu</a><br>
Ez egy automatikus rendszerüzenet a fiókodhoz kapcsolódóan, kérjük, ne válaszolj rá.
</td></tr>
</table></td></tr></table></body></html>
```

---

## 2. Reset password (Jelszó visszaállítása)

**Subject:** `OviTervező - Jelszó visszaállítása`

```html
<!doctype html>
<html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OviTervező</title></head>
<body style="margin:0;padding:0;background:#eef6f1;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef6f1;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #d9ebe0;">
<tr><td style="height:5px;line-height:5px;font-size:0;background:#3fae84;">&nbsp;</td></tr>
<tr><td style="background:#d8f0e3;padding:22px 28px;text-align:center;">
<table role="presentation" cellpadding="0" cellspacing="0" align="center"><tr>
<td style="padding-right:12px;vertical-align:middle;"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="52" height="52" align="center" valign="middle" style="width:52px;height:52px;background:#3fae84;border-radius:12px;color:#ffffff;font-size:22px;font-weight:800;line-height:52px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">OT</td></tr></table></td>
<td style="vertical-align:middle;font-size:26px;line-height:1;color:#1f3d34;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">Ovi<strong style="font-weight:800;color:#2f946f;">Tervező</strong></td>
</tr></table>
</td></tr>
<tr><td style="padding:28px;">
<h1 style="margin:0 0 12px;font-size:22px;color:#1f5f52;">Szia!</h1>
<p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#2d3b36;">Valaki (remélhetőleg te) jelszó-visszaállítást kért az OviTervező fiókodhoz.</p>
<p style="margin:0 0 6px;font-size:16px;line-height:1.6;color:#2d3b36;">Az új jelszavadat az alábbi gombra kattintva adhatod meg:</p>
<p style="margin:22px 0;text-align:center;"><a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#3fae84;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:13px 26px;border-radius:999px;">Új jelszó megadása</a></p>
<p style="margin:0 0 18px;font-size:14px;line-height:1.5;color:#5b6b64;background:#f6f7f7;border-radius:10px;padding:10px 14px;">Ha a gomb nem működik, másold be ezt a linket a böngésződbe:<br><a href="{{ .ConfirmationURL }}" style="color:#2f946f;word-break:break-all;">{{ .ConfirmationURL }}</a></p>
<p style="margin:0 0 18px;font-size:16px;line-height:1.6;color:#2d3b36;">Ha nem te kérted a visszaállítást, hagyd figyelmen kívül ezt a levelet.</p>
<p style="margin:0;font-size:16px;line-height:1.6;color:#2d3b36;">Üdvözlettel,<br><strong>Az OviTervező csapata</strong></p>
</td></tr>
<tr><td style="background:#f6f7f7;padding:18px 28px;border-top:1px solid #e6eae8;font-size:12px;line-height:1.6;color:#7a8480;">
<a href="https://ovitervezo.hu" style="color:#7a8480;">ovitervezo.hu</a><br>
Ez egy automatikus rendszerüzenet a fiókodhoz kapcsolódóan, kérjük, ne válaszolj rá.
</td></tr>
</table></td></tr></table></body></html>
```

---

## 3. Change email address (E-mail cím módosítása)

**Subject:** `OviTervező - E-mail cím megerősítése`

```html
<!doctype html>
<html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OviTervező</title></head>
<body style="margin:0;padding:0;background:#eef6f1;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef6f1;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #d9ebe0;">
<tr><td style="height:5px;line-height:5px;font-size:0;background:#3fae84;">&nbsp;</td></tr>
<tr><td style="background:#d8f0e3;padding:22px 28px;text-align:center;">
<table role="presentation" cellpadding="0" cellspacing="0" align="center"><tr>
<td style="padding-right:12px;vertical-align:middle;"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="52" height="52" align="center" valign="middle" style="width:52px;height:52px;background:#3fae84;border-radius:12px;color:#ffffff;font-size:22px;font-weight:800;line-height:52px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">OT</td></tr></table></td>
<td style="vertical-align:middle;font-size:26px;line-height:1;color:#1f3d34;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">Ovi<strong style="font-weight:800;color:#2f946f;">Tervező</strong></td>
</tr></table>
</td></tr>
<tr><td style="padding:28px;">
<h1 style="margin:0 0 12px;font-size:22px;color:#1f5f52;">Szia!</h1>
<p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#2d3b36;">Kérted az OviTervező fiókodhoz tartozó e-mail cím módosítását.</p>
<p style="margin:0 0 18px;padding:10px 14px;background:#f4fbf7;border-left:4px solid #3fae84;border-radius:8px;font-size:15px;color:#2d3b36;"><strong>Új e-mail cím:</strong> {{ .NewEmail }}</p>
<p style="margin:0 0 6px;font-size:16px;line-height:1.6;color:#2d3b36;">A módosítást az alábbi gombbal tudod megerősíteni:</p>
<p style="margin:22px 0;text-align:center;"><a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#3fae84;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:13px 26px;border-radius:999px;">Új e-mail cím megerősítése</a></p>
<p style="margin:0 0 18px;font-size:14px;line-height:1.5;color:#5b6b64;background:#f6f7f7;border-radius:10px;padding:10px 14px;">Ha a gomb nem működik, másold be ezt a linket a böngésződbe:<br><a href="{{ .ConfirmationURL }}" style="color:#2f946f;word-break:break-all;">{{ .ConfirmationURL }}</a></p>
<p style="margin:0 0 18px;font-size:14px;line-height:1.5;color:#5b6b64;">Ha nem te kérted a módosítást, hagyd figyelmen kívül ezt a levelet, és érdemes megváltoztatnod a jelszavadat.</p>
<p style="margin:0;font-size:16px;line-height:1.6;color:#2d3b36;">Üdvözlettel,<br><strong>Az OviTervező csapata</strong></p>
</td></tr>
<tr><td style="background:#f6f7f7;padding:18px 28px;border-top:1px solid #e6eae8;font-size:12px;line-height:1.6;color:#7a8480;">
<a href="https://ovitervezo.hu" style="color:#7a8480;">ovitervezo.hu</a><br>
Ez egy automatikus rendszerüzenet a fiókodhoz kapcsolódóan, kérjük, ne válaszolj rá.
</td></tr>
</table></td></tr></table></body></html>
```
