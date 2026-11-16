-- Order decisions and write-back (the second half of order drafting; the drafts are in 20261116120000_order_drafts.sql).
--
-- A physician decides each drafted order, one line at a time, in one command (decide_ehr_order_lines). It checks the verified
-- session (the physician role and the order:approve permission, on the drafting clinician's own chart), the draft's version, that no
-- line was decided before, and that an order flagged for an allergy or a major interaction is approved only with that flag acknowledged
-- and a reason given. The application cannot decide a line any other way: the runtime role has no update on the tables.
--
-- Nothing reaches the EHR for a line that is not approved. The write-back ledger (chart_writes) opens a row for an order line only when
-- that line is approved by this physician, with the item key derived from the line, and for the resource type its kind needs
-- (MedicationRequest for a medication, ServiceRequest for a laboratory, imaging or nursing order).
--
-- Retention covers order drafts with the consultations: p_consultation_days removes order drafts last changed longer ago than that,
-- with their lines, audit trail, keys and write-back ledger rows.

create function stetholink_private.is_uuid(p text) returns boolean language sql immutable set search_path = '' as $$
  select p ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
$$;
revoke all on function stetholink_private.is_uuid(text) from public;

create function public.decide_ehr_order_lines(p_draft uuid, p_version integer, p_key text, p_decisions jsonb)
returns setof public.order_drafts language plpgsql security definer set search_path = '' as $$
declare
  c jsonb := stetholink_private.order_context();
  v_fingerprint jsonb;
  v_cached public.order_idempotency%rowtype;
  v_draft public.order_drafts%rowtype;
  v_line public.order_lines%rowtype;
  v_decision jsonb;
  v_line_id uuid;
  v_seen uuid[] := '{}';
  v_approve boolean;
  v_required text[];
  v_ack text[];
  v_reason text;
  v_now timestamptz;
begin
  if not coalesce((c->'roles') ? 'physician' and (c->'scopes') ? 'order:approve', false) then
    raise insufficient_privilege using message = 'Physician authorization is required to approve orders';
  end if;
  if p_draft is null or p_version is null or p_version < 1 or p_key is null or length(p_key) not between 1 and 128
     or jsonb_typeof(p_decisions) is distinct from 'array' or jsonb_array_length(p_decisions) not between 1 and 40 then
    raise invalid_parameter_value using message = 'Invalid order decision command';
  end if;
  v_fingerprint := jsonb_build_object('draftId', p_draft, 'version', p_version, 'decisions', p_decisions);
  -- Serialize retries of one key on one chart before touching rows.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(jsonb_build_array('order-decide', c->>'tenantId', c->>'clinicianId', c->>'patientId', c->>'encounterId', p_key)::text, 0));
  select * into v_cached from public.order_idempotency
    where tenant_id = c->>'tenantId' and clinician_id = (c->>'clinicianId')::uuid and patient_id = c->>'patientId'
      and encounter_id = c->>'encounterId' and action = 'decide' and key = p_key;
  if found then
    if v_cached.fingerprint <> v_fingerprint then raise exception using errcode = 'P0001', message = 'Idempotency key reused for another decision'; end if;
    return query select * from public.order_drafts d where d.id = v_cached.draft_id
      and stetholink_private.order_chart(d.tenant_id, d.clinician_id, d.patient_id, d.encounter_id, d.data_classification);
    return;
  end if;

  if (c->>'expiresAt')::bigint <= extract(epoch from clock_timestamp()) * 1000 then
    raise insufficient_privilege using message = 'Active encounter authorization is required to approve orders';
  end if;
  select * into v_draft from public.order_drafts d where d.id = p_draft
    and stetholink_private.order_chart(d.tenant_id, d.clinician_id, d.patient_id, d.encounter_id, d.data_classification) for update;
  if not found then raise no_data_found using message = 'Order draft not found'; end if;
  if v_draft.version <> p_version then raise exception using errcode = 'P0001', message = 'Stale order draft version'; end if;
  v_now := clock_timestamp();

  for v_decision in select value from jsonb_array_elements(p_decisions) loop
    if jsonb_typeof(v_decision) is distinct from 'object'
       or (v_decision - 'lineId' - 'decision' - 'acknowledged' - 'overrideReason') <> '{}'::jsonb
       or not stetholink_private.is_uuid(v_decision->>'lineId')
       or v_decision->>'decision' is null or v_decision->>'decision' not in ('approve','reject')
       or (v_decision ? 'overrideReason' and (jsonb_typeof(v_decision->'overrideReason') is distinct from 'string' or length(v_decision->>'overrideReason') > 500))
       or (v_decision ? 'acknowledged' and (jsonb_typeof(v_decision->'acknowledged') is distinct from 'array'
          or exists (select 1 from jsonb_array_elements(v_decision->'acknowledged') a
            where jsonb_typeof(a) is distinct from 'string'
              or a #>> '{}' not in ('allergy','allergies_unchecked','duplicate_active','duplicate_order','interaction','interactions_unchecked')))) then
      raise invalid_parameter_value using message = 'Invalid order decision';
    end if;
    v_line_id := (v_decision->>'lineId')::uuid;
    if v_line_id = any(v_seen) then raise invalid_parameter_value using message = 'An order is decided once in a command'; end if;
    v_seen := v_seen || v_line_id;
    select * into v_line from public.order_lines l where l.id = v_line_id and l.draft_id = p_draft for update;
    if not found then raise no_data_found using message = 'Order not found'; end if;
    if v_line.status <> 'pending' then raise exception using errcode = 'P0001', message = 'This order was already decided'; end if;
    v_approve := v_decision->>'decision' = 'approve';
    v_required := '{}';
    v_ack := coalesce(array(select distinct a #>> '{}' as kind from jsonb_array_elements(coalesce(v_decision->'acknowledged', '[]'::jsonb)) a order by kind), '{}');
    v_reason := btrim(coalesce(v_decision->>'overrideReason', ''));
    if v_approve then
      -- What the physician must acknowledge, with a reason: an allergy, and a major interaction.
      select coalesce(array_agg(distinct f->>'kind'), '{}') into v_required from jsonb_array_elements(v_line.content->'flags') f
        where f->>'kind' = 'allergy' or (f->>'kind' = 'interaction' and f->>'severity' = 'major');
      if cardinality(v_required) > 0 and (not (v_required <@ v_ack) or length(v_reason) < 10) then
        raise invalid_parameter_value using message = 'An allergy or a major interaction needs an acknowledgement and a reason';
      end if;
    end if;
    update public.order_lines set status = case when v_approve then 'approved' else 'rejected' end,
      decided_by = (c->>'clinicianId')::uuid, decided_at = v_now,
      acknowledged = case when v_approve and cardinality(v_ack) > 0 then to_jsonb(v_ack) else null end,
      override_reason = case when v_approve and v_reason <> '' then v_reason else null end
      where id = v_line_id;
    insert into public.order_events(draft_id, line_id, tenant_id, clinician_id, event_type, detail)
      values (p_draft, v_line_id, v_draft.tenant_id, v_draft.clinician_id, case when v_approve then 'line_approved' else 'line_rejected' end,
        jsonb_build_object('kind', v_line.kind, 'overridden', v_approve and cardinality(v_required) > 0));
  end loop;

  update public.order_drafts set version = version + 1, updated_at = clock_timestamp() where id = p_draft returning * into v_draft;
  insert into public.order_idempotency(tenant_id, clinician_id, patient_id, encounter_id, action, key, draft_id, fingerprint, version)
    values (v_draft.tenant_id, v_draft.clinician_id, v_draft.patient_id, v_draft.encounter_id, 'decide', p_key, v_draft.id, v_fingerprint, v_draft.version);
  return next v_draft;
end $$;
revoke all on function public.decide_ehr_order_lines(uuid, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.decide_ehr_order_lines(uuid, integer, text, jsonb) to stetholink_runtime;

-- The write-back ledger takes order lines and the two resources that carry an order.
alter table public.chart_writes drop constraint chart_writes_origin_kind_check;
alter table public.chart_writes add constraint chart_writes_origin_kind_check
  check (origin_kind in ('scribe_note','scribe_update','consultation','specialist_report','order'));
alter table public.chart_writes drop constraint chart_writes_resource_type_check;
alter table public.chart_writes add constraint chart_writes_resource_type_check
  check (resource_type in ('DocumentReference','AllergyIntolerance','Condition','MedicationStatement','Observation','ServiceRequest','MedicationRequest'));

-- Opens (or returns) the ledger row for one item. Refused unless the physician approved its origin.
-- This is the definition of 20261114130000_chart_writes.sql with one more origin: an order line the physician approved.
create or replace function public.begin_chart_write(p_origin_kind text, p_origin_id text, p_item_key text, p_resource_type text)
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
  elsif p_origin_kind = 'order' then
    -- An order line this physician approved, on this chart, under the key derived from the line, as the resource its kind needs.
    select true into v_ok from public.order_lines l where l.id::text = p_origin_id
      and stetholink_private.chart_matches(l.tenant_id, l.clinician_id, l.patient_id, l.encounter_id)
      and l.data_classification = v_class and l.status = 'approved' and l.decided_by = (ctx->>'clinicianId')::uuid
      and coalesce((ctx->'scopes') ? 'order:approve', false)
      and p_resource_type = case when l.kind = 'medication' then 'MedicationRequest' else 'ServiceRequest' end
      and p_item_key = 'sl-ord-' || replace(l.id::text, '-', '');
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

-- Retention: this is the definition of 20261114160000_retention.sql with order drafts added to the consultation period.
create or replace function public.run_retention(p_scribe_days integer default null, p_consultation_days integer default null, p_ledger_days integer default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_sessions integer; v_transcripts integer; v_visits integer := 0; v_consultations integer := 0; v_orders integer := 0; v_ledger integer := 0;
  v_ids text[];
  v_order_ids uuid[];
begin
  if session_user = 'stetholink_runtime' then raise insufficient_privilege using message = 'Retention is not run by the application'; end if;
  if least(coalesce(p_scribe_days, 1), coalesce(p_consultation_days, 1), coalesce(p_ledger_days, 1)) < 1 then
    raise invalid_parameter_value using message = 'A retention period is at least one day';
  end if;
  perform set_config('stetholink.retention', 'on', true);

  delete from stetholink_private.browser_sessions where expires_at <= now();
  get diagnostics v_sessions = row_count;

  -- Transcripts past their date, whether or not the note was written.
  with expired as (
    update public.scribe_sessions set transcript_deleted_at = clock_timestamp(), updated_at = clock_timestamp()
      where transcript_deleted_at is null and transcript_expires_at <= now() returning id, tenant_id, clinician_id)
  , gone as (delete from public.scribe_segments where session_id in (select id from expired))
  insert into public.scribe_events(session_id, tenant_id, clinician_id, event_type, detail)
    select id, tenant_id, clinician_id, 'transcript_deleted', '{"reason":"expired"}' from expired;
  get diagnostics v_transcripts = row_count;

  if p_scribe_days is not null then
    select array_agg(id::text) into v_ids from public.scribe_sessions
      where status in ('written','discarded','approved') and updated_at < now() - make_interval(days => p_scribe_days);
    if v_ids is not null then
      delete from public.scribe_events where session_id::text = any(v_ids);
      delete from public.chart_writes where origin_kind in ('scribe_note','scribe_update') and origin_id = any(v_ids);
      delete from public.scribe_sessions where id::text = any(v_ids);
      v_visits := array_length(v_ids, 1);
    end if;
  end if;

  if p_consultation_days is not null then
    select array_agg(id) into v_ids from public.consultation_drafts
      where status in ('responded','rejected','cancelled','archived','failed') and updated_at < now() - make_interval(days => p_consultation_days);
    if v_ids is not null then
      delete from public.consultation_provider_responses where draft_id = any(v_ids);
      delete from public.consultation_delivery_attempts where draft_id = any(v_ids);
      delete from public.consultation_idempotency where draft_id = any(v_ids);
      delete from public.consultation_events where draft_id = any(v_ids);
      delete from public.consultation_revisions where draft_id = any(v_ids);
      delete from public.consultation_approvals where draft_id = any(v_ids);
      delete from public.chart_writes where origin_kind in ('consultation','specialist_report') and origin_id = any(v_ids);
      delete from public.consultation_drafts where id = any(v_ids);
      v_consultations := array_length(v_ids, 1);
    end if;
    -- Order drafts: whatever their state, when they were last changed longer ago than the period. The chart holds what was written.
    select array_agg(id) into v_order_ids from public.order_drafts where updated_at < now() - make_interval(days => p_consultation_days);
    if v_order_ids is not null then
      delete from public.chart_writes where origin_kind = 'order' and origin_id in (select l.id::text from public.order_lines l where l.draft_id = any(v_order_ids));
      delete from public.order_events where draft_id = any(v_order_ids);
      delete from public.order_idempotency where draft_id = any(v_order_ids);
      delete from public.order_lines where draft_id = any(v_order_ids);
      delete from public.order_drafts where id = any(v_order_ids);
      v_orders := array_length(v_order_ids, 1);
    end if;
  end if;

  if p_ledger_days is not null then
    delete from stetholink_private.usage_ledger where usage_day < (now() - make_interval(days => p_ledger_days))::date;
    get diagnostics v_ledger = row_count;
  end if;
  return jsonb_build_object('expiredSessions', v_sessions, 'transcriptsDeleted', v_transcripts, 'visitsDeleted', v_visits,
    'consultationsDeleted', v_consultations, 'orderDraftsDeleted', v_orders, 'ledgerRowsDeleted', v_ledger);
end $$;
