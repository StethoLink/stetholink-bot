-- Data classification replaces the synthetic-only gate.
--
-- Until now every draft, provider envelope and provider callback had to carry
-- `syntheticOnly: true`. They now carry `dataClassification` ('synthetic' | 'live'),
-- and each command checks it against the classification of the verified session in
-- the transaction-local context the application already sets (`stetholink.context`),
-- so a live tenant's physician uses the same approval, routing and callback path.
--
-- Rules enforced here, in addition to the application:
--   * A session without a valid classification cannot run any command.
--   * A new draft, its facts and a new envelope must carry the session's classification.
--   * A session can only change, approve or dispatch a consultation of its own
--     classification. Synthetic and live are never mixed.
--   * A callback must carry the classification of the tenant (`stetholink.data_classification`,
--     set by the server for the callback transaction), of the request and of the consultation.
--   * Rows written before this migration (`syntheticOnly: true`, or no typed provenance)
--     are unchanged, stay readable and count as synthetic. The old flag is no longer
--     accepted on new writes.
--
-- Additive: no table, column, policy or stored row changes. The three functions below are
-- the definitions from 20261111231412 (command engine) and 20261112000000 (dispatch,
-- callback) with only the classification conditions changed; chart scope, physician role,
-- review and route scopes, the approval match, the recipient allowlist, versioning,
-- idempotency and lifecycle rules are textually identical. Deploy together with the
-- application version that sets `dataClassification` in the session context.

-- Classification of one record. A record carrying both fields, or an unknown value, has none.
create function stetholink_private.record_classification(p jsonb) returns text
language sql immutable set search_path = '' as $$
 select case
  when p is null or jsonb_typeof(p) is distinct from 'object' then null
  when p ? 'dataClassification' and p ? 'syntheticOnly' then null
  when jsonb_typeof(p->'dataClassification') = 'string' and p->>'dataClassification' in ('synthetic','live') then p->>'dataClassification'
  when not (p ? 'dataClassification') and p->>'syntheticOnly' = 'true' then 'synthetic'
 end;
$$;

-- Classification of the verified session. The legacy flag is not a session classification.
create function stetholink_private.context_classification(p_context jsonb) returns text
language sql immutable set search_path = '' as $$
 select case when jsonb_typeof(p_context->'dataClassification') = 'string'
   and p_context->>'dataClassification' in ('synthetic','live') then p_context->>'dataClassification' end;
$$;

-- Classification of a stored consultation. Drafts without typed provenance predate
-- classification, when only synthetic data could be stored.
create function stetholink_private.draft_classification(p_metadata jsonb) returns text
language sql immutable set search_path = '' as $$
 select case when p_metadata->'grounding'->'provenance' is null then 'synthetic'
  else stetholink_private.record_classification(p_metadata->'grounding'->'provenance') end;
$$;

-- Synthetic sessions store only synthetic-source facts and attachment references; live sessions only EHR-source ones.
create function stetholink_private.facts_match_classification(p_facts jsonb,p_classification text) returns boolean
language sql immutable set search_path = '' as $$
 select p_facts is null or (jsonb_typeof(p_facts) = 'array' and not exists(
  select 1 from jsonb_array_elements(p_facts) f
  where (f->'source'->>'type' = 'synthetic') is distinct from (p_classification = 'synthetic')));
$$;

-- A stored record in its current form, for comparing a retransmission with a legacy row.
create function stetholink_private.with_classification(p jsonb) returns jsonb
language sql immutable set search_path = '' as $$
 select case when p ? 'syntheticOnly' and not (p ? 'dataClassification') and p->>'syntheticOnly' = 'true'
  then (p - 'syntheticOnly') || jsonb_build_object('dataClassification','synthetic') else p end;
$$;

revoke all on function stetholink_private.record_classification(jsonb),
 stetholink_private.context_classification(jsonb),
 stetholink_private.draft_classification(jsonb),
 stetholink_private.facts_match_classification(jsonb,text),
 stetholink_private.with_classification(jsonb) from public,anon,authenticated,stetholink_runtime;

-- Command engine (create, review, revise, submit, cancel, queue and delivery results).
create or replace function stetholink_private.consultation_command(p_id text,p_action text,p_expected integer,p_key text,p_payload jsonb)
returns setof public.consultation_drafts
language plpgsql security definer set search_path = '' as $$
declare
 c jsonb := nullif(current_setting('stetholink.context',true),'')::jsonb;
 d public.consultation_drafts%rowtype;
 cached public.consultation_idempotency%rowtype;
 fingerprint jsonb;
 target text;
 recipient text;
 attempt public.consultation_delivery_attempts%rowtype;
 metadata jsonb;
 approval public.consultation_approvals%rowtype;
 stamp timestamptz;
 is_routing boolean := p_action in ('queue','dispatch','sent','accepted','responded','failed');
 is_approval boolean := p_action in ('approve','reject','request_changes');
 classification text := stetholink_private.context_classification(c);
begin
 if not coalesce(stetholink_private.chart_matches(c->>'tenantId',(c->>'clinicianId')::uuid,c->>'patientId',c->>'encounterId'),false)
   then raise insufficient_privilege using message='Active chart authorization required'; end if;
 if classification is null
   then raise insufficient_privilege using message='Verified data classification required'; end if;
 if not coalesce((c->'scopes') ? (case when is_approval then 'consultation:approve'
      when is_routing then 'consultation:route' else 'consultation:draft' end),false)
   or ((is_approval or is_routing) and not coalesce((c->'roles') ? 'physician',false))
   then raise insufficient_privilege using message='Clinician authorization required'; end if;
 if p_id is null or length(p_id) not between 1 and 128 or p_action is null or p_payload is null
   or (p_key is not null and length(p_key) not between 1 and 128)
   or (p_expected is not null and p_expected<1)
   then raise invalid_parameter_value using message='Invalid command'; end if;
 if p_action<>'create' and (p_key is null or p_expected is null)
   then raise invalid_parameter_value using message='Version and idempotency key required'; end if;
 if p_action in ('approve','queue','dispatch') then
   recipient := p_payload->>'recipientId';
   if jsonb_typeof(p_payload->'recipientId') is distinct from 'string' or length(recipient) not between 1 and 128
     then raise invalid_parameter_value using message='Recipient required'; end if;
   if not coalesce(nullif(current_setting('stetholink.recipients',true),'')::jsonb ? recipient,false)
     then raise insufficient_privilege using message='Recipient is not allowed for this tenant'; end if;
 end if;
 fingerprint := case when p_action='create' then jsonb_build_object('action',p_action,'request',p_payload->'request')
   else jsonb_build_object('id',p_id,'action',p_action,'version',p_expected,'payload',p_payload) end;
 if p_key is not null then
  -- Serialize retries before touching rows. Scope is per verified chart, not per
  -- process. Hash collisions only serialize unrelated work; uniqueness is exact.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(jsonb_build_array(c->>'tenantId',c->>'clinicianId',c->>'patientId',c->>'encounterId',p_key)::text,0));
  select * into cached from public.consultation_idempotency
   where tenant_id=c->>'tenantId' and clinician_id=(c->>'clinicianId')::uuid and patient_id=c->>'patientId'
    and encounter_id is not distinct from c->>'encounterId' and key=p_key;
  if found then
   if (c->>'expiresAt')::bigint <= extract(epoch from clock_timestamp()) * 1000
    then raise insufficient_privilege using message='Active chart authorization required'; end if;
   if cached.fingerprint<>fingerprint then raise exception using errcode='P0001',message='Idempotency key reused for another command'; end if;
   if stetholink_private.draft_classification(cached.response->'clinical_metadata') is distinct from classification
    then raise insufficient_privilege using message='Consultation belongs to another data classification'; end if;
   return query select * from jsonb_populate_record(null::public.consultation_drafts,cached.response);
   return;
  end if;
 end if;
 if p_action='create' then
  if nullif(c->>'encounterId','') is null or (c->>'expiresAt')::bigint <= extract(epoch from clock_timestamp()) * 1000
   then raise insufficient_privilege using message='Active encounter authorization required'; end if;
  if p_payload->'request'->>'patientId' is distinct from c->>'patientId'
   or p_payload->'request'->>'encounterId' is distinct from c->>'encounterId'
   or p_payload->'draft'->>'patientId' is distinct from c->>'patientId'
   or p_payload->'draft'->>'encounterId' is distinct from c->>'encounterId'
   or p_payload->'draft'->>'status' not in ('pending_approval','pending_review')
   or p_payload->'draft'->'grounding'->'provenance' ? 'syntheticOnly'
   or p_payload->'draft'->'grounding'->'provenance'->>'dataClassification' is distinct from classification
   or not stetholink_private.facts_match_classification(p_payload->'draft'->'clinicalFacts',classification)
   or not stetholink_private.facts_match_classification(p_payload->'draft'->'missingInformation',classification)
   or not stetholink_private.facts_match_classification(p_payload->'draft'->'attachments',classification)
    then raise invalid_parameter_value using message='Invalid draft context or data classification'; end if;
  -- Select only present top-level fields. Recursive null stripping would erase
  -- required unknown values inside grounding (question/specialty/references).
  select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into metadata
   from jsonb_each(p_payload->'draft') where key in ('grounding','clinicalFacts','missingInformation','attachments');
  insert into public.consultation_drafts(id,tenant_id,clinician_id,patient_id,encounter_id,status,summary,assessment,plan,provider,model,prompt_version,clinical_metadata)
   values(p_id,c->>'tenantId',(c->>'clinicianId')::uuid,c->>'patientId',c->>'encounterId','pending_review',
    p_payload->'draft'->>'summary',p_payload->'draft'->>'assessment',p_payload->'draft'->'plan',
    p_payload->'draft'->'grounding'->'provenance'->>'provider',p_payload->'draft'->'grounding'->'provenance'->>'model',
    p_payload->'draft'->'grounding'->'provenance'->>'promptVersion',
    metadata)
   returning * into d;
 else
  select * into d from public.consultation_drafts where id=p_id
   and stetholink_private.chart_matches(tenant_id,clinician_id,patient_id,encounter_id) for update;
  if not found then raise no_data_found using message='Draft not found'; end if;
  if stetholink_private.draft_classification(d.clinical_metadata) is distinct from classification
   then raise insufficient_privilege using message='Consultation belongs to another data classification'; end if;
  stamp := clock_timestamp();
  if nullif(d.encounter_id,'') is null or (c->>'expiresAt')::bigint <= extract(epoch from stamp) * 1000
   then raise insufficient_privilege using message='Active encounter authorization required'; end if;
  if d.version<>p_expected then raise exception using errcode='P0001',message='Stale consultation version'; end if;
  target := d.status;
  if is_approval then
   if d.status not in ('pending_review','pending_approval')
    then raise exception using errcode='P0001',message='Consultation is not pending review'; end if;
   target := case p_action when 'approve' then 'approved' when 'reject' then 'rejected' else 'draft' end;
   insert into public.consultation_approvals(draft_id,tenant_id,clinician_id,patient_id,encounter_id,version,decision,recipient_id,decided_at)
    values(d.id,d.tenant_id,d.clinician_id,d.patient_id,d.encounter_id,d.version+1,p_action,recipient,stamp);
  elsif p_action='revise' then
   if d.status<>'draft' then raise exception using errcode='P0001',message='Changes require an editable draft'; end if;
   if length(p_payload->>'summary') not between 1 and 16000 or length(p_payload->>'assessment')>16000
     or jsonb_typeof(p_payload->'plan') is distinct from 'array' or jsonb_array_length(p_payload->'plan')>80
     then raise invalid_parameter_value using message='Invalid revision'; end if;
  elsif p_action='submit' and d.status='draft' then target := 'pending_review';
  elsif p_action='cancel' and d.status in ('draft','pending_review','pending_approval','approved','queued','failed') then target := 'cancelled';
  elsif p_action in ('queue','dispatch') and d.status in ('approved','failed') then
   select * into attempt from public.consultation_delivery_attempts where draft_id=d.id order by attempt_number desc limit 1;
   if found and (attempt.sent_at is not null or attempt.approval_version is null)
    then raise exception using errcode='P0001',message='Delivery cannot be retried'; end if;
   target := case p_action when 'queue' then 'queued' else 'sent' end;
  elsif (p_action='sent' and d.status='queued') or (p_action='accepted' and d.status='sent')
    or (p_action='responded' and d.status in ('sent','accepted')) or (p_action='failed' and d.status in ('queued','sent','accepted')) then
   target := p_action;
  else raise exception using errcode='P0001',message='Invalid lifecycle transition';
  end if;
  if is_routing then
   if p_action not in ('queue','dispatch') then
    select * into attempt from public.consultation_delivery_attempts where draft_id=d.id order by attempt_number desc limit 1;
    recipient := attempt.recipient_id;
   end if;
   -- Match the immutable physician decision and exact approved content. The current
   -- allowlist is checked again when an existing queued attempt is sent.
   select a.* into approval from public.consultation_approvals a
    join public.consultation_revisions r on r.draft_id=a.draft_id and r.version=a.version
    where a.draft_id=d.id and a.tenant_id=d.tenant_id and a.clinician_id=d.reviewed_by
      and a.patient_id=d.patient_id and a.encounter_id=d.encounter_id and a.decided_at=d.reviewed_at
      and a.decision='approve' and a.recipient_id=recipient and a.recipient_id=d.approved_recipient_id
      and a.version<=d.version and r.snapshot->>'status'='approved'
      and r.snapshot->>'summary'=d.summary and r.snapshot->>'assessment'=d.assessment
      and r.snapshot->'plan'=d.plan and r.snapshot->'clinical_metadata'=d.clinical_metadata;
   if not found or (p_action not in ('queue','dispatch') and attempt.approval_version is distinct from approval.version)
     or (p_action='sent' and (attempt.status<>'queued' or attempt.sent_at is not null))
    then raise insufficient_privilege using message='Matching physician approval required'; end if;
   if p_action='sent' and not coalesce(nullif(current_setting('stetholink.recipients',true),'')::jsonb ? recipient,false)
    then raise insufficient_privilege using message='Recipient is not allowed for this tenant'; end if;
   if p_action in ('queue','dispatch') then
    insert into public.consultation_delivery_attempts(draft_id,tenant_id,clinician_id,patient_id,encounter_id,
     attempt_number,recipient_id,status,approval_version,sent_at)
     values(d.id,d.tenant_id,d.clinician_id,d.patient_id,d.encounter_id,coalesce(attempt.attempt_number,0)+1,
      recipient,target,approval.version,case when p_action='dispatch' then stamp end);
   else
    update public.consultation_delivery_attempts set status=target,updated_at=stamp,
     sent_at=case when p_action='sent' then stamp else sent_at end where id=attempt.id;
   end if;
  elsif target='cancelled' then
   update public.consultation_delivery_attempts set status=target,updated_at=stamp
    where draft_id=d.id and attempt_number=(select max(attempt_number) from public.consultation_delivery_attempts where draft_id=d.id);
  end if;
  update public.consultation_drafts set status=target,version=version+1,updated_at=stamp,
   summary=case when p_action='revise' then p_payload->>'summary' else summary end,
   assessment=case when p_action='revise' then p_payload->>'assessment' else assessment end,
   plan=case when p_action='revise' then p_payload->'plan' else plan end,
   approved_recipient_id=case when p_action='approve' then recipient
     when is_approval or p_action in ('revise','submit') then null else approved_recipient_id end,
   reviewed_by=case when is_approval then d.clinician_id when p_action in ('revise','submit') then null else reviewed_by end,
   reviewed_at=case when is_approval then stamp when p_action in ('revise','submit') then null else reviewed_at end
   where id=d.id returning * into d;
 end if;
 if p_key is not null then
  insert into public.consultation_idempotency(draft_id,tenant_id,clinician_id,patient_id,encounter_id,key,fingerprint,response)
   values(d.id,d.tenant_id,d.clinician_id,d.patient_id,d.encounter_id,p_key,fingerprint,to_jsonb(d));
 end if;
 return next d;
end $$;

-- Dispatch: the envelope carries the classification of the routing session; the engine
-- has already matched the consultation to that session.
create or replace function public.dispatch_ehr_consultation(p_id text,p_version integer,p_key text,p_recipient text,p_envelope jsonb)
returns setof public.consultation_drafts language plpgsql security definer set search_path = '' as $$
declare
 c jsonb := nullif(current_setting('stetholink.context',true),'')::jsonb;
 d public.consultation_drafts%rowtype;
begin
 if not coalesce((c->'roles') ? 'physician' and (c->'scopes') ? 'consultation:route',false)
  then raise insufficient_privilege using message='Physician authorization required'; end if;
 if p_recipient is null or p_envelope is null or jsonb_typeof(p_envelope) is distinct from 'object'
   or p_envelope->>'providerId' is distinct from p_recipient
   or p_envelope->>'tenantId' is distinct from c->>'tenantId'
   or stetholink_private.context_classification(c) is null
   or p_envelope ? 'syntheticOnly'
   or p_envelope->>'dataClassification' is distinct from stetholink_private.context_classification(c)
   or p_envelope ? 'requestId' or p_envelope ? 'attempt'
  then raise invalid_parameter_value using message='Invalid consultation envelope'; end if;
 if exists(select 1 from public.consultation_delivery_attempts a where a.draft_id=p_id and a.status='rejected'
   and stetholink_private.chart_matches(a.tenant_id,a.clinician_id,a.patient_id,a.encounter_id))
  then raise exception using errcode='P0001',message='Provider declined this consultation'; end if;
 select * into d from stetholink_private.consultation_command(p_id,'queue',p_version,p_key,jsonb_build_object('recipientId',p_recipient));
 -- The provider receives exactly what the physician approved, attributed to that approval.
 if p_envelope->>'summary' is distinct from d.summary or p_envelope->>'assessment' is distinct from d.assessment
   or p_envelope->'plan' is distinct from d.plan
   or p_envelope->'approval'->>'approvedBy' is distinct from d.reviewed_by::text
   or (p_envelope->'approval'->>'approvedAt')::timestamptz is distinct from date_trunc('milliseconds',d.reviewed_at)
  then raise invalid_parameter_value using message='Envelope does not match the approved consultation'; end if;
 -- Only a newly created attempt lacks an envelope; an idempotent replay changes nothing.
 update public.consultation_delivery_attempts
  set envelope = p_envelope || jsonb_build_object('requestId',id::text,'attempt',attempt_number)
  where draft_id=d.id and status='queued' and envelope is null;
 return next d;
end $$;

-- Provider callback ingestion. No clinician session exists here.
create or replace function public.record_provider_callback(p_tenant text,p_request_id uuid,p_provider text,p_response_id text,p_kind text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
 a public.consultation_delivery_attempts%rowtype;
 d public.consultation_drafts%rowtype;
 prior public.consultation_provider_responses%rowtype;
 target text;
 disposition text := 'applied';
 stamp timestamptz := clock_timestamp();
begin
 if session_user <> 'stetholink_runtime' then raise insufficient_privilege using message='Runtime role required'; end if;
 if p_tenant is null or p_request_id is null or p_provider is null or p_payload is null
   or p_response_id is null or length(p_response_id) not between 1 and 128
   or p_kind is null or p_kind not in ('accepted','rejected','report')
   or jsonb_typeof(p_payload) is distinct from 'object'
   or p_payload ? 'syntheticOnly'
   or stetholink_private.record_classification(p_payload) is null
   or (p_kind='report' and not coalesce(length(p_payload->'report'->>'summary') between 1 and 8000,false))
  then raise invalid_parameter_value using message='Invalid provider callback'; end if;
 select * into a from public.consultation_delivery_attempts
  where id=p_request_id and tenant_id=p_tenant and recipient_id=p_provider;
 -- One answer for unknown, foreign-tenant and wrong-provider requests.
 if not found then raise no_data_found using message='Request not found'; end if;
 select * into d from public.consultation_drafts where id=a.draft_id and tenant_id=a.tenant_id for update;
 select * into a from public.consultation_delivery_attempts where id=p_request_id;
 -- The callback carries the classification of the tenant and of the request it answers.
 if stetholink_private.record_classification(p_payload) is distinct from nullif(current_setting('stetholink.data_classification',true),'')
   or stetholink_private.record_classification(p_payload) is distinct from
     (case when a.envelope is null then stetholink_private.draft_classification(d.clinical_metadata)
       else stetholink_private.record_classification(a.envelope) end)
   or stetholink_private.record_classification(p_payload) is distinct from stetholink_private.draft_classification(d.clinical_metadata)
  then raise invalid_parameter_value using message='Callback data classification does not match the request'; end if;
 select * into prior from public.consultation_provider_responses where request_id=a.id and response_id=p_response_id;
 if found then
  -- A provider may retransmit with a new send time; the content must be unchanged.
  if prior.kind<>p_kind or (stetholink_private.with_classification(prior.payload) - 'sentAt')<>(p_payload - 'sentAt') then raise exception using errcode='P0001',message='Response id reused for another callback'; end if;
  return jsonb_build_object('disposition','duplicate','status',d.status);
 end if;
 if a.attempt_number<>(select max(attempt_number) from public.consultation_delivery_attempts where draft_id=a.draft_id)
   or d.status in ('cancelled','archived') or a.status in ('cancelled','rejected')
  then raise exception using errcode='P0001',message='Request is closed'; end if;
 if a.status='responded' then
  if p_kind<>'accepted' then raise exception using errcode='P0001',message='Request already has a response'; end if;
  disposition := 'ignored';
 elsif p_kind='accepted' then
  if a.status='accepted' then disposition := 'ignored'; else target := 'accepted'; end if;
 elsif p_kind='rejected' then target := 'rejected';
 else target := 'responded';
 end if;
 insert into public.consultation_provider_responses(request_id,draft_id,tenant_id,clinician_id,patient_id,encounter_id,provider_id,response_id,kind,disposition,payload,received_at)
  values(a.id,a.draft_id,a.tenant_id,a.clinician_id,a.patient_id,a.encounter_id,a.recipient_id,p_response_id,p_kind,disposition,p_payload,stamp);
 if target is not null then
  -- queued/failed here mean the provider answered before, or despite, our transport result.
  -- Either way the provider has the request, so it counts as sent and is never re-sent.
  update public.consultation_delivery_attempts set status=target,updated_at=stamp,
   sent_at=case when approval_version is not null then coalesce(sent_at,stamp) else sent_at end,
   failure_code=case when target='rejected' then 'provider_rejected' else null end where id=a.id;
  update public.consultation_drafts set status=case when target='rejected' then 'failed' else target end,
   version=version+1,updated_at=stamp where id=d.id returning * into d;
 end if;
 return jsonb_build_object('disposition',disposition,'status',d.status);
end $$;
