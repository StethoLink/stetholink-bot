-- Owner: Codex. Migrations are append-only; never edit a merged migration.
create table if not exists public.consultation_drafts (
  id text primary key,
  patient_id text not null,
  encounter_id text,
  status text not null check (status in ('draft','pending_approval','approved','rejected','archived')),
  summary text not null default '',
  assessment text not null default '',
  plan jsonb not null default '[]'::jsonb,
  generated_by text not null default 'ai' check (generated_by = 'ai'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Clinician decisions are stored apart from AI output, in an append-only audit table.
create table if not exists public.consultation_approvals (
  id bigint generated always as identity primary key,
  draft_id text not null references public.consultation_drafts(id) on delete restrict,
  clinician_id uuid not null,
  decision text not null check (decision in ('approve','reject','request_changes')),
  comment text,
  decided_at timestamptz not null default now()
);

alter table public.consultation_drafts enable row level security;
alter table public.consultation_approvals enable row level security;
-- No policies yet: access is denied by default until Codex adds explicit RLS policies.
