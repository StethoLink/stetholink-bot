-- M3 extends the EHR-scoped aggregate in place. No historical records are removed.
alter table public.consultation_drafts
  add column version integer not null default 1 check (version > 0),
  add column clinical_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(clinical_metadata) = 'object');
alter table public.consultation_drafts drop constraint consultation_drafts_status_check;
alter table public.consultation_drafts add constraint consultation_drafts_status_check
  check (status in ('draft','pending_approval','pending_review','approved','rejected','queued','sent','accepted','responded','failed','cancelled','archived'));
alter table public.consultation_drafts add constraint consultation_draft_tenant_identity unique (id, tenant_id);

-- Every child carries request, hospital/tenant and chart identity. Only narrowly
-- scoped functions/triggers write these tables; runtime cannot forge or erase history.
create table public.consultation_revisions (
  draft_id text not null, tenant_id text not null, clinician_id uuid not null,
  patient_id text not null, encounter_id text,
  version integer not null, snapshot jsonb not null, recorded_at timestamptz not null default clock_timestamp(),
  primary key (draft_id, version),
  foreign key (draft_id, tenant_id) references public.consultation_drafts(id, tenant_id) on delete restrict
);
create table public.consultation_events (
  draft_id text not null, tenant_id text not null, clinician_id uuid not null,
  patient_id text not null, encounter_id text,
  version integer not null, event_type text not null, from_status text, to_status text not null,
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (draft_id, version),
  foreign key (draft_id, tenant_id) references public.consultation_drafts(id, tenant_id) on delete restrict
);
create table public.consultation_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  draft_id text not null, tenant_id text not null, clinician_id uuid not null,
  patient_id text not null, encounter_id text,
  attempt_number integer not null check (attempt_number > 0),
  recipient_id text not null, transport text not null default 'mock' check (transport = 'mock'),
  status text not null check (status in ('queued','sent','accepted','responded','failed','cancelled')),
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
  unique (draft_id, attempt_number),
  foreign key (draft_id, tenant_id) references public.consultation_drafts(id, tenant_id) on delete restrict
);
create table public.consultation_idempotency (
  draft_id text not null, tenant_id text not null, clinician_id uuid not null,
  patient_id text not null, encounter_id text,
  key text not null check (length(key) between 1 and 128),
  fingerprint jsonb not null, response jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  unique nulls not distinct (tenant_id, clinician_id, patient_id, encounter_id, key),
  foreign key (draft_id, tenant_id) references public.consultation_drafts(id, tenant_id) on delete restrict
);

alter table public.consultation_approvals
  add column tenant_id text, add column patient_id text, add column encounter_id text, add column version integer;
update public.consultation_approvals a set tenant_id=d.tenant_id, patient_id=d.patient_id, encounter_id=d.encounter_id
  from public.consultation_drafts d where d.id=a.draft_id;

create function stetholink_private.capture_consultation_revision() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.tenant_id is null then return new; end if;
  insert into public.consultation_revisions(draft_id,tenant_id,clinician_id,patient_id,encounter_id,version,snapshot)
    values(new.id,new.tenant_id,new.clinician_id,new.patient_id,new.encounter_id,new.version,to_jsonb(new));
  insert into public.consultation_events(draft_id,tenant_id,clinician_id,patient_id,encounter_id,version,event_type,from_status,to_status)
    values(new.id,new.tenant_id,new.clinician_id,new.patient_id,new.encounter_id,new.version,
      case when tg_op='INSERT' then 'created' when old.status<>new.status then 'status_changed' else 'revised' end,
      case when tg_op='INSERT' then null else old.status end,new.status);
  return new;
end $$;
revoke all on function stetholink_private.capture_consultation_revision() from public;
create trigger capture_consultation_revision after insert or update on public.consultation_drafts
  for each row execute function stetholink_private.capture_consultation_revision();

-- Baseline existing scoped aggregates before normalizing the old state. Historical
-- tenantless records stay untouched and inaccessible to EHR sessions.
insert into public.consultation_revisions(draft_id,tenant_id,clinician_id,patient_id,encounter_id,version,snapshot)
 select id,tenant_id,clinician_id,patient_id,encounter_id,version,to_jsonb(d) from public.consultation_drafts d where tenant_id is not null;
insert into public.consultation_events(draft_id,tenant_id,clinician_id,patient_id,encounter_id,version,event_type,to_status)
 select id,tenant_id,clinician_id,patient_id,encounter_id,version,'migration_baseline',status from public.consultation_drafts where tenant_id is not null;
update public.consultation_drafts set status='pending_review',version=version+1,updated_at=clock_timestamp()
 where tenant_id is not null and status='pending_approval';

-- Reuse the existing insert policy and tighten new concurrency fields. The legacy
-- alias remains accepted for old backend callers and is normalized by commands.
create policy ehr_insert_lifecycle_guard on public.consultation_drafts as restrictive for insert to stetholink_runtime
 with check (version=1 and clinical_metadata='{}'::jsonb);

-- All durable child reads use the same verified chart boundary as their parent.
do $$ declare t text; begin
 foreach t in array array['consultation_revisions','consultation_events','consultation_delivery_attempts','consultation_idempotency'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,stetholink_runtime',t);
  execute format('grant select on public.%I to stetholink_runtime',t);
  execute format('create policy ehr_chart_read on public.%I for select to stetholink_runtime using (stetholink_private.chart_matches(tenant_id,clinician_id,patient_id,encounter_id))',t);
 end loop;
end $$;
grant select on public.consultation_approvals to stetholink_runtime;
create policy ehr_chart_approval_read on public.consultation_approvals for select to stetholink_runtime
 using (stetholink_private.chart_matches(tenant_id,clinician_id,patient_id,encounter_id));

-- Private command engine. Public wrappers keep approval separate from lifecycle
-- commands. The runtime cannot invoke this function or update aggregates directly.
create function stetholink_private.consultation_command(p_id text,p_action text,p_expected integer,p_key text,p_payload jsonb)
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
 stamp timestamptz := clock_timestamp();
 is_approval boolean := p_action in ('approve','reject','request_changes');
begin
 if not coalesce(stetholink_private.chart_matches(c->>'tenantId',(c->>'clinicianId')::uuid,c->>'patientId',c->>'encounterId'),false)
   then raise insufficient_privilege using message='Active chart authorization required'; end if;
 if not coalesce((c->'scopes') ? (case when is_approval then 'consultation:approve' else 'consultation:draft' end),false)
   or (is_approval and not coalesce((c->'roles') ? 'physician',false))
   then raise insufficient_privilege using message='Clinician authorization required'; end if;
 if p_id is null or length(p_id) not between 1 and 128 or p_action is null or p_payload is null
   or (p_key is not null and length(p_key) not between 1 and 128)
   or (p_expected is not null and p_expected<1)
   then raise invalid_parameter_value using message='Invalid command'; end if;
 if p_action not in ('create','approve','reject','request_changes') and (p_key is null or p_expected is null)
   then raise invalid_parameter_value using message='Version and idempotency key required'; end if;
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
   if cached.fingerprint<>fingerprint then raise exception using errcode='P0001',message='Idempotency key reused for another command'; end if;
   return query select * from jsonb_populate_record(null::public.consultation_drafts,cached.response);
   return;
  end if;
 end if;
 if p_action='create' then
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
  if p_expected is not null and d.version<>p_expected then raise exception using errcode='P0001',message='Stale consultation version'; end if;
  target := d.status;
  if is_approval then
   -- Compatibility: older callers may approve a changes-requested draft. New
   -- versioned clients must submit it to review first.
   if d.status not in ('pending_review','pending_approval') and not (p_expected is null and d.status='draft')
    then raise exception using errcode='P0001',message='Consultation is not pending review'; end if;
   if length(p_payload->>'comment')>4000 then raise invalid_parameter_value using message='Comment too long'; end if;
   target := case p_action when 'approve' then 'approved' when 'reject' then 'rejected' else 'draft' end;
   insert into public.consultation_approvals(draft_id,tenant_id,clinician_id,patient_id,encounter_id,version,decision,comment,decided_at)
    values(d.id,d.tenant_id,d.clinician_id,d.patient_id,d.encounter_id,d.version+1,p_action,p_payload->>'comment',stamp);
  elsif p_action='revise' then
   if d.status<>'draft' then raise exception using errcode='P0001',message='Changes require an editable draft'; end if;
   if length(p_payload->>'summary') not between 1 and 16000 or length(p_payload->>'assessment')>16000
     or jsonb_typeof(p_payload->'plan') is distinct from 'array' or jsonb_array_length(p_payload->'plan')>80
     then raise invalid_parameter_value using message='Invalid revision'; end if;
  elsif p_action='submit' and d.status='draft' then target := 'pending_review';
  elsif p_action='cancel' and d.status in ('draft','pending_review','pending_approval','approved','queued','failed') then target := 'cancelled';
  elsif p_action='queue' and d.status in ('approved','failed') then
   if d.reviewed_by is null or d.reviewed_at is null then raise insufficient_privilege using message='Stored physician approval required'; end if;
   recipient := p_payload->>'recipientId';
   if recipient is null or not coalesce(nullif(current_setting('stetholink.recipients',true),'')::jsonb ? recipient,false)
    then raise insufficient_privilege using message='Recipient is not allowed for this tenant'; end if;
   select * into attempt from public.consultation_delivery_attempts where draft_id=d.id order by attempt_number desc limit 1;
   if found and attempt.recipient_id<>recipient then raise exception using errcode='P0001',message='Retry cannot redirect recipient'; end if;
   insert into public.consultation_delivery_attempts(draft_id,tenant_id,clinician_id,patient_id,encounter_id,attempt_number,recipient_id,status)
    values(d.id,d.tenant_id,d.clinician_id,d.patient_id,d.encounter_id,coalesce(attempt.attempt_number,0)+1,recipient,'queued');
   target := 'queued';
  elsif (p_action='sent' and d.status='queued') or (p_action='accepted' and d.status='sent')
    or (p_action='responded' and d.status in ('sent','accepted')) or (p_action='failed' and d.status in ('queued','sent','accepted')) then
   target := p_action;
  else raise exception using errcode='P0001',message='Invalid lifecycle transition';
  end if;
  if target in ('sent','accepted','responded','failed','cancelled') then
   update public.consultation_delivery_attempts set status=target,updated_at=stamp
    where draft_id=d.id and attempt_number=(select max(attempt_number) from public.consultation_delivery_attempts where draft_id=d.id);
  end if;
  update public.consultation_drafts set status=target,version=version+1,updated_at=stamp,
   summary=case when p_action='revise' then p_payload->>'summary' else summary end,
   assessment=case when p_action='revise' then p_payload->>'assessment' else assessment end,
   plan=case when p_action='revise' then p_payload->'plan' else plan end,
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
revoke all on function stetholink_private.consultation_command(text,text,integer,text,jsonb) from public,anon,authenticated,stetholink_runtime;

create function public.create_ehr_consultation(p_draft jsonb,p_request jsonb,p_key text)
returns setof public.consultation_drafts language sql security definer set search_path = '' as $$
 select * from stetholink_private.consultation_command(p_draft->>'id','create',null,p_key,jsonb_build_object('draft',p_draft,'request',p_request));
$$;
create function public.change_ehr_consultation(p_id text,p_action text,p_version integer,p_key text,p_payload jsonb)
returns setof public.consultation_drafts language plpgsql security definer set search_path = '' as $$
begin
 if p_action is null or p_action not in ('revise','submit','cancel','queue','sent','accepted','responded','failed')
  then raise invalid_parameter_value using message='Invalid lifecycle command'; end if;
 return query select * from stetholink_private.consultation_command(p_id,p_action,p_version,p_key,p_payload);
end $$;
create function public.approve_ehr_consultation_versioned(p_id text,p_decision text,p_comment text,p_version integer,p_key text)
returns setof public.consultation_drafts language plpgsql security definer set search_path = '' as $$
begin
 if p_decision is null or p_decision not in ('approve','reject','request_changes') then raise invalid_parameter_value using message='Invalid decision'; end if;
 return query select * from stetholink_private.consultation_command(p_id,p_decision,p_version,p_key,jsonb_build_object('comment',p_comment));
end $$;
-- Keep the old signature and semantics, now with durable revisions/events.
create or replace function public.record_ehr_consultation_approval(p_draft_id text,p_decision text,p_comment text)
returns setof public.consultation_drafts language sql security definer set search_path = '' as $$
 select * from public.approve_ehr_consultation_versioned(p_draft_id,p_decision,p_comment,null,null);
$$;
revoke all on function public.create_ehr_consultation(jsonb,jsonb,text), public.change_ehr_consultation(text,text,integer,text,jsonb),
 public.approve_ehr_consultation_versioned(text,text,text,integer,text) from public,anon,authenticated;
grant execute on function public.create_ehr_consultation(jsonb,jsonb,text), public.change_ehr_consultation(text,text,integer,text,jsonb),
 public.approve_ehr_consultation_versioned(text,text,text,integer,text) to stetholink_runtime;
