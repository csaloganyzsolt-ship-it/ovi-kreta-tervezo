-- Kifizetett rendelés számlázási / kézbesítési hibájának rögzítése (a rendelés fizetett marad).
-- A kód ezek nélkül is működik; a hibák megjelenítéséhez az Admin Központban kell.
alter table public.orders add column if not exists last_error text;
alter table public.orders add column if not exists last_error_at timestamptz;
