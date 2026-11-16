-- Order drafting: one drafted set of orders for a visit, its lines, an append-only audit trail and the idempotency record.
--
-- The model never reaches these tables. The application stores a draft only through create_ehr_order_draft, which checks the
-- verified session (stetholink.context): the clinician's own chart, the data classification, the order:draft permission, that
-- every cited fact is part of the draft and that every line is still pending. A decision on a line is made only by the physician
-- command of the next migration (20261116130000_order_decisions.sql); the runtime role cannot write these tables directly, and
-- the content of a line cannot change after it was drafted, whoever asks.
-- Every row is bound to tenant, clinician, patient, encounter and data classification. Drafts are readable by the clinician who
-- drafted them on that chart only; the duplicate check reads only catalog ids and statuses of the whole visit (encounter_order_items).

create table public.order_drafts (
  id uuid primary key,
  tenant_id text not null,
  clinician_id uuid not null,
  patient_id text not null,
  encounter_id text not null,
  data_classification text not null check (data_classification in ('synthetic','live')),
  mode text not null check (mode in ('specific','case_based')),
  -- The physician's own words.
  request text not null check (length(request) between 1 and 2000),
  catalog_version text not null check (length(catalog_version) between 1 and 64),
  unmatched jsonb not null default '[]' check (jsonb_typeof(unmatched) = 'array'),
  notes jsonb not null default '[]' check (jsonb_typeof(notes) = 'array'),
  -- The chart facts the lines and their flags cite, and what the chart did not give.
  clinical_facts jsonb not null check (jsonb_typeof(clinical_facts) = 'array'),
  missing_information jsonb not null check (jsonb_typeof(missing_information) = 'array'),
  provenance jsonb not null check (jsonb_typeof(provenance) = 'object'),
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index order_drafts_chart on public.order_drafts(tenant_id, clinician_id, patient_id, encounter_id, created_at desc);

create table public.order_lines (
  id uuid primary key,
  draft_id uuid not null references public.order_drafts(id) on delete cascade,
  tenant_id text not null,
  clinician_id uuid not null,
  patient_id text not null,
  encounter_id text not null,
  data_classification text not null check (data_classification in ('synthetic','live')),
  position integer not null check (position between 0 and 39),
  catalog_item_id text not null check (length(catalog_item_id) between 1 and 128),
  kind text not null check (kind in ('lab','imaging','medication','nursing')),
  -- What the physician reviews about the order: display name, code, medication, basis, the physician's words, reason, cited facts, flags.
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  decided_by uuid,
  decided_at timestamptz,
  -- The flag kinds the physician acknowledged, and the reason for going ahead where an override is required.
  acknowledged jsonb check (acknowledged is null or jsonb_typeof(acknowledged) = 'array'),
  override_reason text check (override_reason is null or length(override_reason) <= 500),
  created_at timestamptz not null default clock_timestamp(),
  unique (draft_id, position),
  check ((status = 'pending') = (decided_by is null and decided_at is null))
);
create index order_lines_visit on public.order_lines(tenant_id, patient_id, encounter_id, catalog_item_id);

-- Identifiers, counts and outcomes only: never request text, order text or patient data.
create table public.order_events (
  id bigint generated always as identity primary key,
  draft_id uuid not null,
  line_id uuid,
  tenant_id text not null,
  clinician_id uuid not null,
  event_type text not null check (event_type in ('created','line_approved','line_rejected','chart_write')),
  detail jsonb not null default '{}' check (jsonb_typeof(detail) = 'object' and length(detail::text) <= 4000),
  recorded_at timestamptz not null default clock_timestamp()
);
create index order_events_draft on public.order_events(draft_id, id);

-- One row per command a clinician repeats with the same key (creating a draft, deciding lines): a repeat of the same command returns
-- the first result, the same key for another command is refused.
create table public.order_idempotency (
  tenant_id text not null,
  clinician_id uuid not null,
  patient_id text not null,
  encounter_id text not null,
  action text not null check (action in ('create','decide')),
  key text not null check (length(key) between 1 and 128),
  draft_id uuid not null references public.order_drafts(id) on delete cascade,
  fingerprint jsonb not null,
  -- The draft version the command produced.
  version integer not null check (version >= 1),
  created_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, clinician_id, patient_id, encounter_id, action, key)
);

alter table public.order_drafts enable row level security;
alter table public.order_lines enable row level security;
alter table public.order_events enable row level security;
alter table public.order_idempotency enable row level security;
revoke all on public.order_drafts, public.order_lines, public.order_events, public.order_idempotency from public, anon, authenticated;
grant select on public.order_drafts, public.order_lines, public.order_events, public.order_idempotency to stetholink_runtime;

-- The verified session's own chart and data classification, with the permission to draft orders.
create function stetholink_private.order_chart(p_tenant text, p_clinician uuid, p_patient text, p_encounter text, p_classification text)
returns boolean language sql stable set search_path = '' as $$
  select stetholink_private.chart_matches(p_tenant, p_clinician, p_patient, p_encounter)
    and p_classification = stetholink_private.context_classification(ctx)
    and coalesce((ctx->'scopes') ? 'order:draft', false)
  from (select nullif(current_setting('stetholink.context', true), '')::jsonb as ctx) as c;
$$;
revoke all on function stetholink_private.order_chart(text, uuid, text, text, text) from public;
grant execute on function stetholink_private.order_chart(text, uuid, text, text, text) to stetholink_runtime;

create policy order_drafts_read_own_chart on public.order_drafts for select to stetholink_runtime
  using (stetholink_private.order_chart(tenant_id, clinician_id, patient_id, encounter_id, data_classification));
create policy order_lines_read_own_chart on public.order_lines for select to stetholink_runtime
  using (stetholink_private.order_chart(tenant_id, clinician_id, patient_id, encounter_id, data_classification));
create policy order_events_read_own_chart on public.order_events for select to stetholink_runtime
  using (exists (select 1 from public.order_drafts d where d.id = draft_id));
create policy order_idempotency_read_own_chart on public.order_idempotency for select to stetholink_runtime
  using (exists (select 1 from public.order_drafts d where d.id = draft_id));

-- The audit trail: the application can add to it through the commands and never change it. Retention runs as another login.
create function stetholink_private.order_audit_append_only() returns trigger language plpgsql set search_path = '' as $$
begin
  if session_user = 'stetholink_runtime' then raise insufficient_privilege using message = 'The order audit trail is append-only'; end if;
  return coalesce(old, new);
end $$;
create trigger order_events_append_only before update or delete on public.order_events
  for each row execute function stetholink_private.order_audit_append_only();

-- A drafted order never changes: not its words, not its cited facts, not its place. Only its decision is added, once.
create function stetholink_private.order_line_fixed() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.id is distinct from old.id or new.draft_id is distinct from old.draft_id or new.tenant_id is distinct from old.tenant_id
     or new.clinician_id is distinct from old.clinician_id or new.patient_id is distinct from old.patient_id
     or new.encounter_id is distinct from old.encounter_id or new.data_classification is distinct from old.data_classification
     or new.position is distinct from old.position or new.catalog_item_id is distinct from old.catalog_item_id
     or new.kind is distinct from old.kind or new.content is distinct from old.content then
    raise insufficient_privilege using message = 'A drafted order cannot be changed';
  end if;
  if old.status <> 'pending' and (new.status is distinct from old.status or new.decided_by is distinct from old.decided_by
     or new.decided_at is distinct from old.decided_at or new.acknowledged is distinct from old.acknowledged
     or new.override_reason is distinct from old.override_reason) then
    raise insufficient_privilege using message = 'A decided order cannot be decided again';
  end if;
  return new;
end $$;
create trigger order_line_fixed before update on public.order_lines
  for each row execute function stetholink_private.order_line_fixed();

create function stetholink_private.order_draft_fixed() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id or new.clinician_id is distinct from old.clinician_id
     or new.patient_id is distinct from old.patient_id or new.encounter_id is distinct from old.encounter_id
     or new.data_classification is distinct from old.data_classification or new.mode is distinct from old.mode
     or new.request is distinct from old.request or new.catalog_version is distinct from old.catalog_version
     or new.unmatched is distinct from old.unmatched or new.notes is distinct from old.notes
     or new.clinical_facts is distinct from old.clinical_facts or new.missing_information is distinct from old.missing_information
     or new.provenance is distinct from old.provenance or new.created_at is distinct from old.created_at then
    raise insufficient_privilege using message = 'A drafted order set cannot be changed';
  end if;
  return new;
end $$;
create trigger order_draft_fixed before update on public.order_drafts
  for each row execute function stetholink_private.order_draft_fixed();

-- The session behind a command: active, unexpired, on its own chart, classified and allowed to draft orders.
create function stetholink_private.order_context() returns jsonb language plpgsql stable set search_path = '' as $$
declare c jsonb := nullif(current_setting('stetholink.context', true), '')::jsonb;
begin
  if session_user <> 'stetholink_runtime' or c is null
     or not coalesce(stetholink_private.chart_matches(c->>'tenantId', (c->>'clinicianId')::uuid, c->>'patientId', c->>'encounterId'), false)
     or stetholink_private.context_classification(c) is null or nullif(c->>'encounterId', '') is null
     or not coalesce((c->'scopes') ? 'order:draft', false) then
    raise insufficient_privilege using message = 'Active chart authorization is required to draft orders';
  end if;
  return c;
end $$;
revoke all on function stetholink_private.order_context() from public;

-- Stores a drafted set of orders once per key. Every line must be pending, of the catalog's kinds, and cite only facts the draft holds.
create function public.create_ehr_order_draft(p_draft jsonb, p_request jsonb, p_key text)
returns setof public.order_drafts language plpgsql security definer set search_path = '' as $$
declare
  c jsonb := stetholink_private.order_context();
  v_class text := stetholink_private.context_classification(c);
  v_fingerprint jsonb;
  v_cached public.order_idempotency%rowtype;
  v_draft public.order_drafts%rowtype;
  v_line jsonb;
  v_known text[];
  v_cited text[];
  v_position integer := 0;
begin
  if p_key is null or length(p_key) not between 1 and 128 or jsonb_typeof(p_draft) is distinct from 'object' or jsonb_typeof(p_request) is distinct from 'object' then
    raise invalid_parameter_value using message = 'Invalid order draft command';
  end if;
  v_fingerprint := jsonb_build_object('request', p_request);
  -- Serialize retries of one key on one chart before touching rows.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(jsonb_build_array('order-create', c->>'tenantId', c->>'clinicianId', c->>'patientId', c->>'encounterId', p_key)::text, 0));
  select * into v_cached from public.order_idempotency
    where tenant_id = c->>'tenantId' and clinician_id = (c->>'clinicianId')::uuid and patient_id = c->>'patientId'
      and encounter_id = c->>'encounterId' and action = 'create' and key = p_key;
  if found then
    if v_cached.fingerprint <> v_fingerprint then raise exception using errcode = 'P0001', message = 'Idempotency key reused for another request'; end if;
    return query select * from public.order_drafts d where d.id = v_cached.draft_id and d.data_classification = v_class;
    if not found then raise insufficient_privilege using message = 'Order draft belongs to another data classification'; end if;
    return;
  end if;

  if (c->>'expiresAt')::bigint <= extract(epoch from clock_timestamp()) * 1000 then
    raise insufficient_privilege using message = 'Active encounter authorization is required to draft orders';
  end if;
  if p_draft->>'patientId' is distinct from c->>'patientId' or p_draft->>'encounterId' is distinct from c->>'encounterId'
     or p_request->>'patientId' is distinct from c->>'patientId' or p_request->>'encounterId' is distinct from c->>'encounterId'
     or p_draft->>'request' is distinct from p_request->>'request'
     or coalesce(p_draft->>'id', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     or p_draft->>'mode' is null or p_draft->>'mode' not in ('specific','case_based')
     or p_draft->'provenance'->>'dataClassification' is distinct from v_class
     or jsonb_typeof(p_draft->'lines') is distinct from 'array' or jsonb_array_length(p_draft->'lines') not between 1 and 40
     or jsonb_typeof(p_draft->'clinicalFacts') is distinct from 'array' or jsonb_typeof(p_draft->'missingInformation') is distinct from 'array'
     or not stetholink_private.facts_match_classification(p_draft->'clinicalFacts', v_class)
     or not stetholink_private.facts_match_classification(p_draft->'missingInformation', v_class) then
    raise invalid_parameter_value using message = 'Invalid order draft context or data classification';
  end if;

  select coalesce(array_agg(fact->>'id'), '{}') into v_known from jsonb_array_elements(p_draft->'clinicalFacts') fact;
  for v_line in select value from jsonb_array_elements(p_draft->'lines') loop
    if jsonb_typeof(v_line) is distinct from 'object' or v_line->>'status' is distinct from 'pending'
       or v_line ? 'decidedBy' or v_line ? 'decidedAt' or v_line ? 'acknowledged' or v_line ? 'overrideReason'
       or coalesce(v_line->>'id', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       or v_line->>'kind' is null or v_line->>'kind' not in ('lab','imaging','medication','nursing')
       or length(coalesce(v_line->>'catalogItemId', '')) not between 1 and 128
       or v_line->>'basis' is null or v_line->>'basis' not in ('requested','proposed')
       or jsonb_typeof(v_line->'evidenceIds') is distinct from 'array' or jsonb_typeof(v_line->'flags') is distinct from 'array'
       -- An order the physician did not ask for by name is proposed only on a documented fact.
       or (v_line->>'basis' = 'proposed' and jsonb_array_length(v_line->'evidenceIds') = 0) then
      raise invalid_parameter_value using message = 'Invalid order line';
    end if;
    -- The facts a line and its flags cite are part of the draft, so the physician always sees what the order rests on.
    select coalesce(array_agg(cited), '{}') into v_cited from (
      select jsonb_array_elements_text(v_line->'evidenceIds') as cited
      union all
      select e from jsonb_array_elements(v_line->'flags') f, jsonb_array_elements_text(coalesce(f->'evidenceIds', '[]'::jsonb)) e
    ) s;
    if not (v_cited <@ v_known) then raise invalid_parameter_value using message = 'An order cites a fact that is not part of the draft'; end if;
  end loop;

  insert into public.order_drafts(id, tenant_id, clinician_id, patient_id, encounter_id, data_classification, mode, request, catalog_version,
      unmatched, notes, clinical_facts, missing_information, provenance)
    values ((p_draft->>'id')::uuid, c->>'tenantId', (c->>'clinicianId')::uuid, c->>'patientId', c->>'encounterId', v_class, p_draft->>'mode',
      p_draft->>'request', p_draft->>'catalogVersion', coalesce(p_draft->'unmatched', '[]'::jsonb), coalesce(p_draft->'notes', '[]'::jsonb),
      p_draft->'clinicalFacts', p_draft->'missingInformation', p_draft->'provenance')
    returning * into v_draft;
  for v_line in select value from jsonb_array_elements(p_draft->'lines') loop
    insert into public.order_lines(id, draft_id, tenant_id, clinician_id, patient_id, encounter_id, data_classification, position, catalog_item_id, kind, content)
      values ((v_line->>'id')::uuid, v_draft.id, v_draft.tenant_id, v_draft.clinician_id, v_draft.patient_id, v_draft.encounter_id, v_class, v_position,
        v_line->>'catalogItemId', v_line->>'kind', v_line - 'id' - 'catalogItemId' - 'kind' - 'status');
    v_position := v_position + 1;
  end loop;
  insert into public.order_events(draft_id, tenant_id, clinician_id, event_type, detail)
    values (v_draft.id, v_draft.tenant_id, v_draft.clinician_id, 'created',
      jsonb_build_object('mode', v_draft.mode, 'lines', v_position, 'catalogVersion', v_draft.catalog_version,
        'rejected', coalesce((v_draft.provenance->>'rejectedLines')::integer, 0)));
  insert into public.order_idempotency(tenant_id, clinician_id, patient_id, encounter_id, action, key, draft_id, fingerprint, version)
    values (v_draft.tenant_id, v_draft.clinician_id, v_draft.patient_id, v_draft.encounter_id, 'create', p_key, v_draft.id, v_fingerprint, v_draft.version);
  return next v_draft;
end $$;

-- The orders already drafted or approved for this visit, whoever drafted them, as catalog ids and statuses only: the duplicate check.
create function public.encounter_order_items()
returns table(catalog_item_id text, status text) language plpgsql stable security definer set search_path = '' as $$
declare
  c jsonb := stetholink_private.order_context();
begin
  return query select l.catalog_item_id, l.status from public.order_lines l
    where l.tenant_id = c->>'tenantId' and l.patient_id = c->>'patientId' and l.encounter_id = c->>'encounterId'
      and l.data_classification = stetholink_private.context_classification(c) and l.status <> 'rejected';
end $$;

revoke all on function public.create_ehr_order_draft(jsonb, jsonb, text), public.encounter_order_items() from public, anon, authenticated;
grant execute on function public.create_ehr_order_draft(jsonb, jsonb, text), public.encounter_order_items() to stetholink_runtime;
