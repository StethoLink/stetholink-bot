-- M5/M6: provider routing outbox and correlated specialist responses.
-- Additive only. Existing consultations, attempts and history are preserved.

-- A delivery attempt is the durable, immutable consultation request: its id is the
-- request/correlation identifier given to the provider, and its envelope is the
-- exact approved payload that was (or will be) transmitted.
alter table public.consultation_delivery_attempts
  add column envelope jsonb check (envelope is null or (jsonb_typeof(envelope) = 'object' and pg_column_size(envelope) <= 262144)),
  add column provider_reference text check (length(provider_reference) between 1 and 256),
  add column failure_code text check (failure_code in ('transport_error','transport_timeout','invalid_acknowledgement','provider_rejected'));
alter table public.consultation_delivery_attempts drop constraint consultation_delivery_attempts_status_check;
alter table public.consultation_delivery_attempts add constraint consultation_delivery_attempts_status_check
  check (status in ('queued','sent','accepted','responded','failed','cancelled','rejected'));

create table public.consultation_provider_responses (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.consultation_delivery_attempts(id) on delete restrict,
  draft_id text not null, tenant_id text not null, clinician_id uuid not null,
  patient_id text not null, encounter_id text,
  provider_id text not null,
  response_id text not null check (length(response_id) between 1 and 128),
  kind text not null check (kind in ('accepted','rejected','report')),
  disposition text not null check (disposition in ('applied','ignored')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 65536),
  received_at timestamptz not null default clock_timestamp(),
  unique (request_id, response_id),
  foreign key (draft_id, tenant_id) references public.consultation_drafts(id, tenant_id) on delete restrict
);
create index consultation_provider_responses_draft on public.consultation_provider_responses(draft_id, received_at);
alter table public.consultation_provider_responses enable row level security;
revoke all on public.consultation_provider_responses from public, anon, authenticated, stetholink_runtime;
grant select on public.consultation_provider_responses to stetholink_runtime;
-- Clinician readback uses the same verified chart boundary as the consultation.
create policy ehr_chart_read on public.consultation_provider_responses for select to stetholink_runtime
  using (stetholink_private.chart_matches(tenant_id, clinician_id, patient_id, encounter_id));

-- Clinician lifecycle commands no longer include delivery or provider outcomes.
-- A browser session can therefore never mark a consultation sent, accepted or
-- responded; those states come only from dispatch results and provider callbacks.
create or replace function public.change_ehr_consultation(p_id text,p_action text,p_version integer,p_key text,p_payload jsonb)
returns setof public.consultation_drafts language plpgsql security definer set search_path = '' as $$
begin
 if p_action is null or p_action not in ('revise','submit','cancel')
  then raise invalid_parameter_value using message='Invalid lifecycle command'; end if;
 return query select * from stetholink_private.consultation_command(p_id,p_action,p_version,p_key,p_payload);
end $$;

-- Dispatch: physician-only. Reuses the command engine's stored-approval,
-- recipient-allowlist, version, idempotency and no-redirect checks, then stores the
-- envelope with the database-assigned request id.
create function public.dispatch_ehr_consultation(p_id text,p_version integer,p_key text,p_recipient text,p_envelope jsonb)
returns setof public.consultation_drafts language plpgsql security definer set search_path = '' as $$
declare
 c jsonb := nullif(current_setting('stetholink.context',true),'')::jsonb;
 d public.consultation_drafts%rowtype;
begin
 if not coalesce((c->'roles') ? 'physician' and (c->'scopes') ? 'consultation:approve',false)
  then raise insufficient_privilege using message='Physician authorization required'; end if;
 if p_recipient is null or p_envelope is null or jsonb_typeof(p_envelope) is distinct from 'object'
   or p_envelope->>'providerId' is distinct from p_recipient
   or p_envelope->>'tenantId' is distinct from c->>'tenantId'
   or p_envelope->>'syntheticOnly' is distinct from 'true'
   or p_envelope ? 'requestId' or p_envelope ? 'attempt'
  then raise invalid_parameter_value using message='Invalid consultation envelope'; end if;
 if exists(select 1 from public.consultation_delivery_attempts a where a.draft_id=p_id and a.status='rejected'
   and stetholink_private.chart_matches(a.tenant_id,a.clinician_id,a.patient_id,a.encounter_id))
  then raise exception using errcode='P0001',message='Provider declined this consultation'; end if;
 select * into d from stetholink_private.consultation_command(p_id,'queue',p_version,p_key,jsonb_build_object('recipientId',p_recipient));
 -- Only a newly created attempt lacks an envelope; an idempotent replay changes nothing.
 update public.consultation_delivery_attempts
  set envelope = p_envelope || jsonb_build_object('requestId',id::text,'attempt',attempt_number)
  where draft_id=d.id and status='queued' and envelope is null;
 return next d;
end $$;

-- Result of the transport call for a queued request. A no-op once the request has
-- progressed (duplicate result, a provider callback that arrived first, cancellation).
create function public.record_ehr_dispatch_result(p_request_id uuid,p_outcome text,p_reference text,p_failure text)
returns setof public.consultation_drafts language plpgsql security definer set search_path = '' as $$
declare
 a public.consultation_delivery_attempts%rowtype;
 d public.consultation_drafts%rowtype;
 stamp timestamptz := clock_timestamp();
begin
 if p_request_id is null or p_outcome is null or p_outcome not in ('sent','failed')
   or (p_outcome='sent' and (p_reference is null or p_failure is not null))
   or (p_outcome='failed' and (p_reference is not null or p_failure is null
     or p_failure not in ('transport_error','transport_timeout','invalid_acknowledgement')))
  then raise invalid_parameter_value using message='Invalid dispatch result'; end if;
 select * into a from public.consultation_delivery_attempts where id=p_request_id
  and stetholink_private.chart_matches(tenant_id,clinician_id,patient_id,encounter_id);
 if not found then raise no_data_found using message='Request not found'; end if;
 select * into d from public.consultation_drafts where id=a.draft_id for update;
 select * into a from public.consultation_delivery_attempts where id=p_request_id;
 if a.status<>'queued' or d.status<>'queued' then
  if p_outcome='sent' and a.provider_reference is null then
   update public.consultation_delivery_attempts set provider_reference=p_reference where id=a.id;
  end if;
  return next d; return;
 end if;
 update public.consultation_delivery_attempts set status=p_outcome,provider_reference=p_reference,failure_code=p_failure,updated_at=stamp where id=a.id;
 update public.consultation_drafts set status=p_outcome,version=version+1,updated_at=stamp where id=d.id returning * into d;
 return next d;
end $$;

-- Provider callback ingestion. There is no clinician session: the server verifies
-- the provider's signature first, and this function independently binds the
-- callback to the tenant, the request id and the provider that request was sent to.
create function public.record_provider_callback(p_tenant text,p_request_id uuid,p_provider text,p_response_id text,p_kind text,p_payload jsonb)
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
   or p_payload->>'syntheticOnly' is distinct from 'true'
   or (p_kind='report' and not coalesce(length(p_payload->'report'->>'summary') between 1 and 8000,false))
  then raise invalid_parameter_value using message='Invalid provider callback'; end if;
 select * into a from public.consultation_delivery_attempts
  where id=p_request_id and tenant_id=p_tenant and recipient_id=p_provider;
 -- One answer for unknown, foreign-tenant and wrong-provider requests.
 if not found then raise no_data_found using message='Request not found'; end if;
 select * into d from public.consultation_drafts where id=a.draft_id and tenant_id=a.tenant_id for update;
 select * into a from public.consultation_delivery_attempts where id=p_request_id;
 select * into prior from public.consultation_provider_responses where request_id=a.id and response_id=p_response_id;
 if found then
  -- A provider may retransmit with a new send time; the content must be unchanged.
  if prior.kind<>p_kind or (prior.payload - 'sentAt')<>(p_payload - 'sentAt') then raise exception using errcode='P0001',message='Response id reused for another callback'; end if;
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
  update public.consultation_delivery_attempts set status=target,updated_at=stamp,
   failure_code=case when target='rejected' then 'provider_rejected' else null end where id=a.id;
  update public.consultation_drafts set status=case when target='rejected' then 'failed' else target end,
   version=version+1,updated_at=stamp where id=d.id returning * into d;
 end if;
 return jsonb_build_object('disposition',disposition,'status',d.status);
end $$;

revoke all on function public.dispatch_ehr_consultation(text,integer,text,text,jsonb),
 public.record_ehr_dispatch_result(uuid,text,text,text),
 public.record_provider_callback(text,uuid,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.dispatch_ehr_consultation(text,integer,text,text,jsonb),
 public.record_ehr_dispatch_result(uuid,text,text,text),
 public.record_provider_callback(text,uuid,text,text,text,jsonb) to stetholink_runtime;
