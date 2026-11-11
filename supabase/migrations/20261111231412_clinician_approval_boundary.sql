-- A physician approves one reviewed version for one allowlisted destination.
alter table public.consultation_drafts add column approved_recipient_id text;
alter table public.consultation_approvals add column recipient_id text;
alter table public.consultation_approvals add constraint consultation_approval_destination
  check (recipient_id is null or (decision='approve' and version>1 and length(recipient_id) between 1 and 128));
alter table public.consultation_approvals add constraint consultation_approval_version unique (draft_id,version);
alter table public.consultation_delivery_attempts
  add column approval_version integer,
  add column sent_at timestamptz,
  add constraint consultation_attempt_approval foreign key (draft_id,approval_version)
    references public.consultation_approvals(draft_id,version) on delete restrict,
  add constraint consultation_sent_requires_approval check (sent_at is null or approval_version is not null);
create unique index consultation_single_sent_attempt on public.consultation_delivery_attempts(draft_id)
  where sent_at is not null;

-- Pre-M4 approvals do not identify a destination. Preserve their history and
-- return unsent approved drafts to review. Legacy queued attempts cannot send.
update public.consultation_drafts set status='pending_review',version=version+1,updated_at=clock_timestamp(),
  reviewed_by=null,reviewed_at=null where tenant_id is not null and status='approved';

create function stetholink_private.prevent_audit_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
 raise insufficient_privilege using message='Consultation history is append-only';
end $$;
revoke all on function stetholink_private.prevent_audit_mutation() from public,anon,authenticated,stetholink_runtime;
create trigger immutable_approvals before update or delete or truncate on public.consultation_approvals
 for each statement execute function stetholink_private.prevent_audit_mutation();
create trigger immutable_events before update or delete or truncate on public.consultation_events
 for each statement execute function stetholink_private.prevent_audit_mutation();
create trigger immutable_revisions before update or delete or truncate on public.consultation_revisions
 for each statement execute function stetholink_private.prevent_audit_mutation();

revoke insert on public.consultation_drafts from stetholink_runtime;
revoke select on public.consultation_approvals, public.consultation_idempotency from stetholink_runtime;
revoke execute on function public.record_ehr_consultation_approval(text,text,text),
  public.approve_ehr_consultation_versioned(text,text,text,integer,text) from stetholink_runtime;

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
begin
 if not coalesce(stetholink_private.chart_matches(c->>'tenantId',(c->>'clinicianId')::uuid,c->>'patientId',c->>'encounterId'),false)
   then raise insufficient_privilege using message='Active chart authorization required'; end if;
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
   or p_payload->'draft'->'grounding'->'provenance'->>'syntheticOnly' is distinct from 'true'
    then raise invalid_parameter_value using message='Invalid synthetic draft context'; end if;
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

create function public.review_ehr_consultation(p_id text,p_decision text,p_recipient text,p_version integer,p_key text)
returns setof public.consultation_drafts language plpgsql security definer set search_path = '' as $$
begin
 if p_decision is null or p_decision not in ('approve','reject','request_changes')
   or (p_decision='approve') is distinct from (p_recipient is not null)
  then raise invalid_parameter_value using message='Invalid decision'; end if;
 return query select * from stetholink_private.consultation_command(
  p_id,p_decision,p_version,p_key,jsonb_build_object('recipientId',p_recipient));
end $$;

create function public.dispatch_ehr_consultation(p_id text,p_recipient text,p_version integer,p_key text)
returns setof public.consultation_drafts language sql security definer set search_path = '' as $$
 select * from stetholink_private.consultation_command(
  p_id,'dispatch',p_version,p_key,jsonb_build_object('recipientId',p_recipient));
$$;

revoke all on function public.review_ehr_consultation(text,text,text,integer,text),
  public.dispatch_ehr_consultation(text,text,integer,text) from public,anon,authenticated;
grant execute on function public.review_ehr_consultation(text,text,text,integer,text),
  public.dispatch_ehr_consultation(text,text,integer,text) to stetholink_runtime;
