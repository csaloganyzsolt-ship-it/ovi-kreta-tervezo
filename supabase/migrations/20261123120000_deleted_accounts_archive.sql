-- Törölt fiókok 30 napos archívuma (visszaállítás adminként). Újrafuttatható (idempotens).
-- Csak a backend írja/olvassa a titkos kulccsal: RLS be van kapcsolva, de szándékosan nincs policy, a böngészői szerepköröktől a jogok is elvéve.
create table if not exists public.deleted_accounts_archive (
  id uuid primary key default gen_random_uuid(),
  original_user_id uuid not null,
  email text,
  profile_data jsonb not null default '{}'::jsonb,
  document_ids text[] not null default '{}',
  deleted_at timestamptz not null default now(),
  restore_until timestamptz not null default (now() + interval '30 days')
);

create index if not exists idx_deleted_accounts_archive_restore_until on public.deleted_accounts_archive (restore_until);
create index if not exists idx_deleted_accounts_archive_original_user on public.deleted_accounts_archive (original_user_id);

alter table public.deleted_accounts_archive enable row level security;

revoke all on public.deleted_accounts_archive from anon, authenticated;
