-- Owner: CODEX. Migrations are append-only; never edit a merged migration.
create table if not exists consultations (
  id text primary key,
  patient_id text not null,
  status text not null check (status in ('draft','active','completed','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists messages (
  id text primary key,
  consultation_id text not null references consultations(id) on delete cascade,
  role text not null check (role in ('clinician','assistant','system')),
  content text not null,
  created_at timestamptz not null default now()
);
