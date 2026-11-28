-- Rendelés meta: a kiválasztott napok és az alkalmazott árkomponensek (heti csomag: alapár + napok × felár) rögzítése az utólagos számlázhatósághoz.
-- Idempotens: bármennyiszer újrafuttatható. A kód ezen oszlop nélkül is működik (meta nélkül menti a rendelést, és hangosan jelzi a hiányt).
alter table public.orders add column if not exists meta jsonb;
