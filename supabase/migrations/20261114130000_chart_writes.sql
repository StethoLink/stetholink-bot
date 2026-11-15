-- EHR write-back ledger. One row per item StethoLink is allowed to create in the EHR.
-- A row can be opened only by a physician session with the chart:write permission, for an origin
-- the physician approved (a scribe note and its selected items, an approved consultation, or the
-- specialist report of a consultation that was sent). The model has no path to this table.
-- item_key is the identifier used for the conditional create, so a repeat never creates twice.

create table public.chart_writes (
  id bigint generated always as identity primary key,
  tenant_id text not null,
  clinician_id uuid not null,
  patient_id text not null,
  encounter_id text not null,
  data_classification text not null check (data_classification in ('synthetic','live')),
  origin_kind text not null check (origin_kind in ('scribe_note','scribe_update','consultation','specialist_report')),
  origin_id text not null check (length(origin_id) between 1 and 128),
  item_key text not null check (item_key ~ '^[A-Za-z0-9.-]{8,64}$'),
  resource_type text not null check (resource_type in ('DocumentReference','AllergyIntolerance','Condition','MedicationStatement','Observation')),
  status text not null default 'pending' check (status in ('pending','created','existing','failed','unsupported')),
  -- The id the EHR gave the created resource. Identifier only.
  resource_id text check (resource_id is null or length(resource_id) <= 128),
  failure text check (failure is null or length(failure) <= 200),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, item_key)
);
create index chart_writes_origin on public.chart_writes(tenant_id, origin_kind, origin_id);
alter table public.chart_writes enable row level security;
revoke all on public.chart_writes from public, anon, authenticated;
grant select on public.chart_writes to stetholink_runtime;
create policy chart_writes_read_own_chart on public.chart_writes for select to stetholink_runtime
  using (stetholink_private.chart_matches(tenant_id, clinician_id, patient_id, encounter_id)
    and data_classification = stetholink_private.context_classification(nullif(current_setting('stetholink.context', true), '')::jsonb));

create function stetholink_private.chart_write_context() returns jsonb language plpgsql stable set search_path = '' as $$
declare ctx jsonb := nullif(current_setting('stetholink.context', true), '')::jsonb;
begin
  if session_user <> 'stetholink_runtime' or ctx is null or ctx->>'authorization' <> 'active'
     or (ctx->>'expiresAt')::bigint <= extract(epoch from statement_timestamp()) * 1000
     or not coalesce((ctx->'roles') ? 'physician' and (ctx->'scopes') ? 'chart:write', false)
     or stetholink_private.context_classification(ctx) is null or ctx->>'encounterId' is null then
    raise insufficient_privilege using message = 'Physician authorization is required to write to the chart';
  end if;
  return ctx;
end $$;

-- Opens (or returns) the ledger row for one item. Refused unless the physician approved its origin.
create function public.begin_chart_write(p_origin_kind text, p_origin_id text, p_item_key text, p_resource_type text)
returns setof public.chart_writes language plpgsql security definer set search_path = '' as $$
declare
  ctx jsonb := stetholink_private.chart_write_context();
  v_class text := stetholink_private.context_classification(ctx);
  v_ok boolean := false;
  v_row public.chart_writes%rowtype;
begin
  if p_origin_kind in ('scribe_note','scribe_update') then
    select true into v_ok from public.scribe_sessions s where s.id::text = p_origin_id
      and stetholink_private.chart_matches(s.tenant_id, s.clinician_id, s.patient_id, s.encounter_id)
      and s.data_classification = v_class and s.status in ('approved','written') and s.approved_by = (ctx->>'clinicianId')::uuid
      and case p_origin_kind
        when 'scribe_note' then (s.approval->'selection'->>'note')::boolean and p_resource_type = 'DocumentReference'
        else exists (select 1 from jsonb_array_elements_text(s.approval->'selection'->'updates') as chosen(id)
          where p_item_key like '%-' || chosen.id) and p_resource_type <> 'DocumentReference' end;
  elsif p_origin_kind in ('consultation','specialist_report') then
    select true into v_ok from public.consultation_drafts d where d.id = p_origin_id
      and stetholink_private.chart_matches(d.tenant_id, d.clinician_id, d.patient_id, d.encounter_id)
      and stetholink_private.draft_classification(d.clinical_metadata) = v_class and d.reviewed_by is not null
      and p_resource_type = 'DocumentReference'
      and case p_origin_kind when 'consultation' then d.status in ('approved','queued','sent','accepted','responded','failed')
        else d.status = 'responded' end;
  else
    raise invalid_parameter_value using message = 'Unknown origin';
  end if;
  if not coalesce(v_ok, false) then raise insufficient_privilege using message = 'This item was not approved for the chart'; end if;
  insert into public.chart_writes(tenant_id, clinician_id, patient_id, encounter_id, data_classification, origin_kind, origin_id, item_key, resource_type)
    values (ctx->>'tenantId', (ctx->>'clinicianId')::uuid, ctx->>'patientId', ctx->>'encounterId', v_class, p_origin_kind, p_origin_id, p_item_key, p_resource_type)
    on conflict (tenant_id, item_key) do nothing;
  select * into v_row from public.chart_writes where tenant_id = ctx->>'tenantId' and item_key = p_item_key;
  -- The same key can never be reused for another chart, origin or resource type.
  if v_row.patient_id <> ctx->>'patientId' or v_row.encounter_id <> ctx->>'encounterId' or v_row.origin_kind <> p_origin_kind
     or v_row.origin_id <> p_origin_id or v_row.resource_type <> p_resource_type then
    raise insufficient_privilege using message = 'This item belongs to another chart or record';
  end if;
  return next v_row;
end $$;

create function public.record_chart_write(p_item_key text, p_status text, p_resource_id text, p_failure text)
returns setof public.chart_writes language plpgsql security definer set search_path = '' as $$
declare ctx jsonb := stetholink_private.chart_write_context();
begin
  if p_status not in ('created','existing','failed','unsupported') or (p_status in ('created','existing')) <> (p_resource_id is not null) then
    raise invalid_parameter_value using message = 'Invalid write result';
  end if;
  return query update public.chart_writes set status = p_status, resource_id = p_resource_id, failure = left(p_failure, 200), updated_at = clock_timestamp()
    where tenant_id = ctx->>'tenantId' and item_key = p_item_key and patient_id = ctx->>'patientId' and encounter_id = ctx->>'encounterId'
      -- A recorded success is final: a later failure or retry cannot overwrite it.
      and status not in ('created','existing')
    returning *;
end $$;

revoke all on function stetholink_private.chart_write_context() from public;
revoke all on function public.begin_chart_write(text, text, text, text), public.record_chart_write(text, text, text, text) from public, anon, authenticated;
grant execute on function public.begin_chart_write(text, text, text, text), public.record_chart_write(text, text, text, text) to stetholink_runtime;
