-- Látogatói útvonal (tölcsér) elemzés: névtelen, véletlen munkamenet-azonosító (csak analitikai sütihozzájárulással küldi a böngésző).
-- Nem tárolunk IP-címet, böngészőazonosítót vagy ujjlenyomatot. Idempotens: bármennyiszer újrafuttatható.
alter table public.analytics_events add column if not exists session_id text;

-- Az esemény nevére korábban esetlegesen felvett CHECK megszorítás lecserélése a teljes (bővített) listára.
alter table public.analytics_events drop constraint if exists analytics_events_event_name_check;
alter table public.analytics_events add constraint analytics_events_event_name_check check (event_name in (
  'page_view', 'landing_view', 'pricing_view',
  'planner_step_1', 'planner_step_2', 'planner_step_3', 'planner_step_4',
  'generator_started', 'document_generated', 'paywall_opened', 'checkout_started', 'payment_succeeded',
  'coupon_box_opened', 'download_docx', 'download_pdf', 'auth_modal_opened'
)) not valid;

-- A formátumot a szerver is ellenőrzi; az adatbázis is csak véletlen, azonosításra alkalmatlan mintát enged.
alter table public.analytics_events drop constraint if exists analytics_events_session_id_check;
alter table public.analytics_events add constraint analytics_events_session_id_check check (session_id is null or session_id ~ '^[A-Za-z0-9_-]{16,64}$') not valid;

create index if not exists idx_analytics_events_session on public.analytics_events (session_id, created_at);
