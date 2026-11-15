-- AI scribe: one recorded visit, its transcript segments, the generated note and an audit trail.
-- Audio is never stored. The transcript is working data: it is deleted when the note has been
-- written to the chart, or at transcript_expires_at at the latest.
-- Every row is bound to tenant, clinician, patient, encounter and data classification, and is
-- reachable only by the verified session of that same chart (stetholink.context).

create table public.scribe_sessions (
  id uuid primary key,
  tenant_id text not null,
  clinician_id uuid not null,
  patient_id text not null,
  encounter_id text not null,
  data_classification text not null check (data_classification in ('synthetic','live')),
  status text not null default 'recording'
    check (status in ('recording','transcribed','note_ready','approved','written','discarded')),
  -- The clinician's statement that the patient agreed to the recording. Recording cannot start without it.
  consent_confirmed_at timestamptz not null,
  consent_statement text not null check (length(consent_statement) between 10 and 500),
  spoken_language text not null check (length(spoken_language) between 2 and 20),
  note_language text not null check (note_language in ('en','ar')),
  -- Generated and physician-edited note with its proposed chart updates. Null until generated.
  note jsonb check (note is null or jsonb_typeof(note) = 'object'),
  note_version integer not null default 0 check (note_version >= 0),
  -- What the physician approved: the note version and the exact items selected for the chart.
  approval jsonb check (approval is null or jsonb_typeof(approval) = 'object'),
  approved_by uuid,
  approved_at timestamptz,
  -- Seconds of audio transcribed and money spent on this visit (transcription and note), for the per-visit ceiling.
  audio_seconds numeric(10,2) not null default 0 check (audio_seconds >= 0),
  spend_usd numeric(10,6) not null default 0 check (spend_usd >= 0),
  transcript_expires_at timestamptz not null,
  transcript_deleted_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check ((approved_by is null) = (approved_at is null) and (approved_by is null) = (approval is null)),
  check (status not in ('approved','written') or approved_by is not null)
);
create index scribe_sessions_chart on public.scribe_sessions(tenant_id, clinician_id, patient_id, encounter_id, created_at desc);
create index scribe_sessions_expiry on public.scribe_sessions(transcript_expires_at) where transcript_deleted_at is null;

create table public.scribe_segments (
  session_id uuid not null references public.scribe_sessions(id) on delete cascade,
  -- Position of the uploaded audio chunk, then of the segment inside it: the order of the conversation.
  chunk_index integer not null check (chunk_index between 0 and 999),
  seq integer not null check (seq between 0 and 999),
  speaker text check (speaker is null or speaker in ('clinician','patient','other')),
  started_ms integer not null check (started_ms >= 0),
  ended_ms integer not null check (ended_ms >= started_ms),
  content text not null check (length(content) between 1 and 4000),
  confidence real check (confidence is null or (confidence >= 0 and confidence <= 1)),
  primary key (session_id, chunk_index, seq)
);

-- Identifiers, counts and outcomes only: never transcript text, note text or patient data.
create table public.scribe_events (
  id bigint generated always as identity primary key,
  session_id uuid not null,
  tenant_id text not null,
  clinician_id uuid not null,
  event_type text not null check (event_type in ('consent_confirmed','recording_stopped','note_generated','note_edited',
    'note_approved','chart_write','transcript_deleted','discarded')),
  detail jsonb not null default '{}' check (jsonb_typeof(detail) = 'object' and length(detail::text) <= 4000),
  recorded_at timestamptz not null default clock_timestamp()
);
create index scribe_events_session on public.scribe_events(session_id, id);

alter table public.scribe_sessions enable row level security;
alter table public.scribe_segments enable row level security;
alter table public.scribe_events enable row level security;
revoke all on public.scribe_sessions, public.scribe_segments, public.scribe_events from public, anon, authenticated;
grant select, insert, update on public.scribe_sessions to stetholink_runtime;
grant select, insert, update, delete on public.scribe_segments to stetholink_runtime;
grant select, insert on public.scribe_events to stetholink_runtime;

-- A pure function of its argument; row-level policies evaluated as the runtime role need to call it.
grant execute on function stetholink_private.context_classification(jsonb) to stetholink_runtime;

-- The verified session's own chart and data classification, with the scribe permission.
create function stetholink_private.scribe_chart(p_tenant text, p_clinician uuid, p_patient text, p_encounter text, p_classification text)
returns boolean language sql stable set search_path = '' as $$
  select stetholink_private.chart_matches(p_tenant, p_clinician, p_patient, p_encounter)
    and p_classification = stetholink_private.context_classification(ctx)
    and coalesce((ctx->'scopes') ? 'scribe:record', false)
  from (select nullif(current_setting('stetholink.context', true), '')::jsonb as ctx) as c;
$$;
revoke all on function stetholink_private.scribe_chart(text, uuid, text, text, text) from public;
grant execute on function stetholink_private.scribe_chart(text, uuid, text, text, text) to stetholink_runtime;

create policy scribe_reads_own_chart on public.scribe_sessions for select to stetholink_runtime
  using (stetholink_private.scribe_chart(tenant_id, clinician_id, patient_id, encounter_id, data_classification));
create policy scribe_starts_with_consent on public.scribe_sessions for insert to stetholink_runtime
  with check (stetholink_private.scribe_chart(tenant_id, clinician_id, patient_id, encounter_id, data_classification)
    and status = 'recording' and note is null and note_version = 0 and approval is null and approved_by is null and approved_at is null
    and consent_confirmed_at <= clock_timestamp() + interval '1 minute' and consent_confirmed_at > clock_timestamp() - interval '10 minutes'
    and transcript_deleted_at is null and transcript_expires_at > clock_timestamp() and transcript_expires_at <= clock_timestamp() + interval '31 days');
-- Direct updates are working edits only. Approval and everything after it go through the functions below.
create policy scribe_edits_before_approval on public.scribe_sessions for update to stetholink_runtime
  using (stetholink_private.scribe_chart(tenant_id, clinician_id, patient_id, encounter_id, data_classification)
    and status in ('recording','transcribed','note_ready') and approved_by is null)
  with check (stetholink_private.scribe_chart(tenant_id, clinician_id, patient_id, encounter_id, data_classification)
    and status in ('recording','transcribed','note_ready','discarded') and approval is null and approved_by is null and approved_at is null);

create policy scribe_segments_read on public.scribe_segments for select to stetholink_runtime
  using (exists (select 1 from public.scribe_sessions s where s.id = session_id));
create policy scribe_segments_add on public.scribe_segments for insert to stetholink_runtime
  with check (exists (select 1 from public.scribe_sessions s where s.id = session_id and s.status = 'recording' and s.transcript_deleted_at is null));
-- The physician may correct who is speaking before approval; the words are never edited.
create policy scribe_segments_relabel on public.scribe_segments for update to stetholink_runtime
  using (exists (select 1 from public.scribe_sessions s where s.id = session_id and s.status in ('recording','transcribed','note_ready')))
  with check (exists (select 1 from public.scribe_sessions s where s.id = session_id and s.status in ('recording','transcribed','note_ready')));
create policy scribe_segments_remove on public.scribe_segments for delete to stetholink_runtime
  using (exists (select 1 from public.scribe_sessions s where s.id = session_id));
create function stetholink_private.scribe_segment_words_fixed() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.content is distinct from old.content or new.started_ms is distinct from old.started_ms or new.ended_ms is distinct from old.ended_ms
     or new.session_id is distinct from old.session_id or new.chunk_index is distinct from old.chunk_index or new.seq is distinct from old.seq then
    raise insufficient_privilege using message = 'Transcript words cannot be changed';
  end if;
  return new;
end $$;
create trigger scribe_segment_words_fixed before update on public.scribe_segments
  for each row execute function stetholink_private.scribe_segment_words_fixed();

create policy scribe_events_read on public.scribe_events for select to stetholink_runtime
  using (exists (select 1 from public.scribe_sessions s where s.id = session_id));
create policy scribe_events_add on public.scribe_events for insert to stetholink_runtime
  with check (exists (select 1 from public.scribe_sessions s where s.id = session_id and s.tenant_id = scribe_events.tenant_id)
    and clinician_id::text = nullif(current_setting('stetholink.context', true), '')::jsonb->>'clinicianId'
    and event_type in ('consent_confirmed','recording_stopped','note_generated','note_edited','discarded'));
-- The runtime role can add to the audit trail and never change it. Retention runs as another role.
create function stetholink_private.scribe_audit_append_only() returns trigger language plpgsql set search_path = '' as $$
begin
  if session_user = 'stetholink_runtime' then raise insufficient_privilege using message = 'The scribe audit trail is append-only'; end if;
  return coalesce(old, new);
end $$;
create trigger scribe_events_append_only before update or delete on public.scribe_events
  for each row execute function stetholink_private.scribe_audit_append_only();

-- Physician approval of one version of the note and of an explicit list of chart items.
-- p_selection: {"note": true|false, "updates": ["<proposal id>", ...]}. Every selected proposal must
-- exist in the stored note, be new information and not be a conflict.
create function public.approve_scribe_note(p_session uuid, p_version integer, p_selection jsonb)
returns setof public.scribe_sessions language plpgsql security definer set search_path = '' as $$
declare
  ctx jsonb := nullif(current_setting('stetholink.context', true), '')::jsonb;
  s public.scribe_sessions%rowtype;
  v_time timestamptz := clock_timestamp();
  v_bad integer;
begin
  if session_user <> 'stetholink_runtime'
     or not coalesce((ctx->'roles') ? 'physician' and (ctx->'scopes') ? 'chart:write' and (ctx->'scopes') ? 'scribe:record', false) then
    raise insufficient_privilege using message = 'Physician authorization is required to approve a note';
  end if;
  select * into s from public.scribe_sessions where id = p_session
    and stetholink_private.scribe_chart(tenant_id, clinician_id, patient_id, encounter_id, data_classification) for update;
  if not found then raise no_data_found using message = 'Visit not found'; end if;
  if s.status = 'approved' or s.status = 'written' then
    -- Repeating the same approval is a no-op; a different one is refused.
    if s.approval->'selection' = p_selection and (s.approval->>'noteVersion')::integer = p_version then return query select s.*; return; end if;
    raise exception using errcode = 'P0001', message = 'This note was already approved';
  end if;
  if s.status <> 'note_ready' or s.note is null then raise exception using errcode = 'P0001', message = 'There is no note to approve'; end if;
  if s.note_version <> p_version then raise exception using errcode = 'P0001', message = 'The note changed; review the current version'; end if;
  if jsonb_typeof(p_selection) is distinct from 'object' or jsonb_typeof(p_selection->'note') is distinct from 'boolean'
     or jsonb_typeof(p_selection->'updates') is distinct from 'array' or jsonb_array_length(p_selection->'updates') > 40 then
    raise invalid_parameter_value using message = 'Invalid selection';
  end if;
  select count(*) into v_bad from jsonb_array_elements_text(p_selection->'updates') as chosen(id)
    where not exists (select 1 from jsonb_array_elements(coalesce(s.note->'proposedUpdates', '[]'::jsonb)) as u
      where u->>'id' = chosen.id and u->>'relation' = 'new');
  if v_bad > 0 then raise exception using errcode = 'P0001', message = 'Only new, non-conflicting items of this note can be selected'; end if;
  update public.scribe_sessions set status = 'approved', approved_by = (ctx->>'clinicianId')::uuid, approved_at = v_time, updated_at = v_time,
    approval = jsonb_build_object('noteVersion', p_version, 'selection', p_selection) where id = p_session;
  insert into public.scribe_events(session_id, tenant_id, clinician_id, event_type, detail)
    values (p_session, s.tenant_id, (ctx->>'clinicianId')::uuid, 'note_approved',
      jsonb_build_object('noteVersion', p_version, 'note', p_selection->'note', 'updates', jsonb_array_length(p_selection->'updates')));
  return query select * from public.scribe_sessions where id = p_session;
end $$;

-- After the chart writes: record the outcome, and delete the transcript once the note is in the chart.
create function public.finish_scribe_session(p_session uuid, p_outcome jsonb)
returns setof public.scribe_sessions language plpgsql security definer set search_path = '' as $$
declare
  ctx jsonb := nullif(current_setting('stetholink.context', true), '')::jsonb;
  s public.scribe_sessions%rowtype;
  v_written boolean := coalesce((p_outcome->>'noteInChart')::boolean, false);
begin
  if session_user <> 'stetholink_runtime' then raise insufficient_privilege using message = 'Not allowed'; end if;
  select * into s from public.scribe_sessions where id = p_session
    and stetholink_private.scribe_chart(tenant_id, clinician_id, patient_id, encounter_id, data_classification) for update;
  if not found then raise no_data_found using message = 'Visit not found'; end if;
  if s.status not in ('approved','written') then raise exception using errcode = 'P0001', message = 'The note is not approved'; end if;
  insert into public.scribe_events(session_id, tenant_id, clinician_id, event_type, detail)
    values (p_session, s.tenant_id, (ctx->>'clinicianId')::uuid, 'chart_write', p_outcome - 'noteInChart' || jsonb_build_object('noteInChart', v_written));
  if v_written and s.transcript_deleted_at is null then
    delete from public.scribe_segments where session_id = p_session;
    insert into public.scribe_events(session_id, tenant_id, clinician_id, event_type, detail)
      values (p_session, s.tenant_id, (ctx->>'clinicianId')::uuid, 'transcript_deleted', jsonb_build_object('reason', 'note_written'));
  end if;
  update public.scribe_sessions set status = case when v_written then 'written' else status end, updated_at = clock_timestamp(),
    transcript_deleted_at = case when v_written then coalesce(transcript_deleted_at, clock_timestamp()) else transcript_deleted_at end where id = p_session;
  return query select * from public.scribe_sessions where id = p_session;
end $$;

revoke all on function public.approve_scribe_note(uuid, integer, jsonb), public.finish_scribe_session(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.approve_scribe_note(uuid, integer, jsonb), public.finish_scribe_session(uuid, jsonb) to stetholink_runtime;
