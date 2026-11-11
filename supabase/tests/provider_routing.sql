-- Owner connection to disposable PostgreSQL; all test changes roll back.
begin;
set session authorization stetholink_runtime;
select set_config('stetholink.context',jsonb_build_object(
 'clinicianId','11111111-1111-4111-8111-111111111111','tenantId','synthetic-test-a',
 'patientId','syn-pt-001','encounterId','syn-enc-001','roles','["physician"]'::jsonb,
 'scopes','["consultation:draft","consultation:approve"]'::jsonb,'authorization','active',
 'expiresAt',(extract(epoch from now())*1000)::bigint+600000)::text,true);
select set_config('stetholink.recipients','["team-a","team-b"]',true);
do $$
declare
 ctx jsonb := current_setting('stetholink.context')::jsonb;
 base jsonb := '{"patientId":"syn-pt-001","encounterId":"syn-enc-001","status":"pending_approval","summary":"Synthetic summary","assessment":"Synthetic assessment","plan":[],
   "grounding":{"question":"Synthetic question","specialty":"Cardiology","reason":null,"gaps":[],"conflicts":[],"evidenceIds":[],"safetyFlags":["clinician_review_required"],
   "provenance":{"syntheticOnly":true,"provider":"mock","model":"mock-1","promptVersion":"test","contextVersion":"test","encounterReference":null}}}';
 env jsonb := '{"providerId":"team-a","tenantId":"synthetic-test-a","syntheticOnly":true}';
 report jsonb := '{"syntheticOnly":true,"sentAt":"2026-01-01T00:00:00Z","report":{"summary":"Synthetic report"}}';
 ok jsonb := '{"syntheticOnly":true}';
 d public.consultation_drafts%rowtype;
 a public.consultation_delivery_attempts%rowtype;
 first_request uuid;
 r jsonb;
 n integer;
 name text;
begin
 -- Five consultations.
 foreach name in array array['syn-m5-a','syn-m5-b','syn-m5-c','syn-m5-d','syn-m5-e'] loop
  perform public.create_ehr_consultation(base||jsonb_build_object('id',name),'{"patientId":"syn-pt-001","encounterId":"syn-enc-001"}',null);
 end loop;
 -- An unapproved consultation cannot be dispatched.
 begin
  perform public.dispatch_ehr_consultation('syn-m5-a',1,'unapproved','team-a',env);
  raise exception using errcode='XX000',message='Unapproved consultation dispatched';
 exception when raise_exception then null; end;
 foreach name in array array['syn-m5-a','syn-m5-b','syn-m5-c','syn-m5-d','syn-m5-e'] loop
  perform public.approve_ehr_consultation_versioned(name,'approve',null,1,null);
 end loop;

 -- Only a physician may dispatch; the envelope must match the recipient and tenant.
 perform set_config('stetholink.context',(ctx||'{"roles":["clinician"],"scopes":["consultation:draft"]}')::text,true);
 begin
  perform public.dispatch_ehr_consultation('syn-m5-a',2,'non-physician','team-a',env);
  raise exception using errcode='XX000',message='Non-physician dispatched';
 exception when insufficient_privilege then null; end;
 perform set_config('stetholink.context',ctx::text,true);
 foreach r in array array[env||'{"providerId":"team-b"}', env||'{"tenantId":"synthetic-test-b"}', env-'syntheticOnly',
   env||'{"requestId":"00000000-0000-4000-8000-000000000000"}'] loop
  begin
   perform public.dispatch_ehr_consultation('syn-m5-a',2,'bad-envelope','team-a',r);
   raise exception using errcode='XX000',message='Invalid envelope accepted';
  exception when invalid_parameter_value then null; end;
 end loop;

 -- Dispatch is recorded once; a replay returns the original snapshot without a second request.
 select * into d from public.dispatch_ehr_consultation('syn-m5-a',2,'send-a','team-a',env);
 if d.status<>'queued' or d.version<>3 then raise exception 'Dispatch not queued'; end if;
 select * into d from public.dispatch_ehr_consultation('syn-m5-a',2,'send-a','team-a',env);
 select count(*) into n from public.consultation_delivery_attempts where draft_id='syn-m5-a';
 if n<>1 or d.version<>3 then raise exception 'Replay created a second request'; end if;
 select * into a from public.consultation_delivery_attempts where draft_id='syn-m5-a';
 if a.envelope->>'requestId'<>a.id::text or a.envelope->>'attempt'<>'1' then raise exception 'Envelope not bound to request id'; end if;

 -- Callbacks must match tenant, request and the provider the request was sent to.
 begin perform public.record_provider_callback('synthetic-test-a',a.id,'team-b','x','report',report);
  raise exception using errcode='XX000',message='Wrong provider accepted'; exception when no_data_found then null; end;
 begin perform public.record_provider_callback('synthetic-test-b',a.id,'team-a','x','report',report);
  raise exception using errcode='XX000',message='Wrong tenant accepted'; exception when no_data_found then null; end;
 begin perform public.record_provider_callback('synthetic-test-a',gen_random_uuid(),'team-a','x','report',report);
  raise exception using errcode='XX000',message='Unknown request accepted'; exception when no_data_found then null; end;
 foreach r in array array[report-'syntheticOnly', report-'report', '{"syntheticOnly":true,"report":{"summary":""}}'::jsonb] loop
  begin perform public.record_provider_callback('synthetic-test-a',a.id,'team-a','x','report',r);
   raise exception using errcode='XX000',message='Invalid callback accepted'; exception when invalid_parameter_value then null; end;
 end loop;
 if (select count(*) from public.consultation_provider_responses)<>0 then raise exception 'Refused callback was stored'; end if;

 -- Out of order: the report arrives before the transport result is recorded.
 r := public.record_provider_callback('synthetic-test-a',a.id,'team-a','rep-1','report',report);
 select * into d from public.consultation_drafts where id='syn-m5-a';
 if r->>'disposition'<>'applied' or d.status<>'responded' or d.version<>4 then raise exception 'Early report not applied'; end if;
 select * into d from public.record_ehr_dispatch_result(a.id,'sent','ref-a',null);
 select * into a from public.consultation_delivery_attempts where id=a.id;
 if d.status<>'responded' or d.version<>4 or a.status<>'responded' or a.provider_reference<>'ref-a' then raise exception 'Late transport result regressed state'; end if;
 -- Duplicate, retransmitted with a new send time: no new row, no new version.
 r := public.record_provider_callback('synthetic-test-a',a.id,'team-a','rep-1','report',report||'{"sentAt":"2026-01-02T00:00:00Z"}');
 if r->>'disposition'<>'duplicate' or (select version from public.consultation_drafts where id='syn-m5-a')<>4
   or (select count(*) from public.consultation_provider_responses where request_id=a.id)<>1 then raise exception 'Duplicate callback changed state'; end if;
 begin perform public.record_provider_callback('synthetic-test-a',a.id,'team-a','rep-1','report','{"syntheticOnly":true,"report":{"summary":"Different"}}');
  raise exception using errcode='XX000',message='Response id reuse accepted'; exception when raise_exception then null; end;
 -- Late acceptance after the report is kept for audit but cannot move the state backwards.
 r := public.record_provider_callback('synthetic-test-a',a.id,'team-a','acc-late','accepted',ok);
 if r->>'disposition'<>'ignored' or (select status from public.consultation_drafts where id='syn-m5-a')<>'responded' then raise exception 'Late acceptance regressed state'; end if;
 begin perform public.record_provider_callback('synthetic-test-a',a.id,'team-a','rep-2','report',report);
  raise exception using errcode='XX000',message='Second report replaced the first'; exception when raise_exception then null; end;

 -- Provider rejection closes the request; it cannot be re-sent or answered later.
 perform public.dispatch_ehr_consultation('syn-m5-b',2,'send-b','team-a',env);
 select * into a from public.consultation_delivery_attempts where draft_id='syn-m5-b';
 perform public.record_ehr_dispatch_result(a.id,'sent','ref-b',null);
 perform public.record_provider_callback('synthetic-test-a',a.id,'team-a','rej','rejected',ok||'{"reason":"Synthetic refusal"}');
 select * into d from public.consultation_drafts where id='syn-m5-b';
 select * into a from public.consultation_delivery_attempts where id=a.id;
 if d.status<>'failed' or a.status<>'rejected' or a.failure_code<>'provider_rejected' then raise exception 'Rejection not recorded'; end if;
 begin perform public.dispatch_ehr_consultation('syn-m5-b',d.version,'resend-b','team-a',env);
  raise exception using errcode='XX000',message='Rejected request re-sent'; exception when raise_exception then null; end;
 begin perform public.record_provider_callback('synthetic-test-a',a.id,'team-a','rep-after-reject','report',report);
  raise exception using errcode='XX000',message='Report accepted after rejection'; exception when raise_exception then null; end;

 -- Transport failure, retry to the same provider, and a callback for the superseded request.
 perform public.dispatch_ehr_consultation('syn-m5-c',2,'send-c1','team-a',env);
 select id into first_request from public.consultation_delivery_attempts where draft_id='syn-m5-c';
 select * into d from public.record_ehr_dispatch_result(first_request,'failed',null,'transport_timeout');
 if d.status<>'failed' then raise exception 'Failure not recorded'; end if;
 begin perform public.dispatch_ehr_consultation('syn-m5-c',d.version,'redirect-c','team-b',env||'{"providerId":"team-b"}');
  raise exception using errcode='XX000',message='Retry redirected to another provider'; exception when raise_exception then null; end;
 select * into d from public.dispatch_ehr_consultation('syn-m5-c',d.version,'send-c2','team-a',env);
 select * into a from public.consultation_delivery_attempts where draft_id='syn-m5-c' and attempt_number=2;
 if a.id=first_request then raise exception 'Retry reused the request id'; end if;
 begin perform public.record_provider_callback('synthetic-test-a',first_request,'team-a','late','report',report);
  raise exception using errcode='XX000',message='Superseded request answered'; exception when raise_exception then null; end;
 perform public.record_ehr_dispatch_result(a.id,'sent','ref-c',null);
 r := public.record_provider_callback('synthetic-test-a',a.id,'team-a','acc','accepted',ok);
 if (select status from public.consultation_drafts where id='syn-m5-c')<>'accepted' then raise exception 'Acceptance not applied'; end if;
 r := public.record_provider_callback('synthetic-test-a',a.id,'team-a','acc-2','accepted',ok);
 if r->>'disposition'<>'ignored' then raise exception 'Repeated acceptance applied twice'; end if;

 -- A timed-out request that the provider did receive: its late report is still linked.
 perform public.dispatch_ehr_consultation('syn-m5-d',2,'send-d','team-a',env);
 select * into a from public.consultation_delivery_attempts where draft_id='syn-m5-d';
 perform public.record_ehr_dispatch_result(a.id,'failed',null,'transport_timeout');
 r := public.record_provider_callback('synthetic-test-a',a.id,'team-a','rep-d','report',report);
 if (select status from public.consultation_drafts where id='syn-m5-d')<>'responded' then raise exception 'Late report after timeout lost'; end if;
 -- A cancelled consultation accepts no callback, and a late transport result cannot revive it.
 perform public.dispatch_ehr_consultation('syn-m5-e',2,'send-e','team-a',env);
 select * into a from public.consultation_delivery_attempts where draft_id='syn-m5-e';
 perform public.change_ehr_consultation('syn-m5-e','cancel',3,'cancel-e','{}');
 begin perform public.record_provider_callback('synthetic-test-a',a.id,'team-a','rep-e','report',report);
  raise exception using errcode='XX000',message='Cancelled consultation answered'; exception when raise_exception then null; end;
 select * into d from public.record_ehr_dispatch_result(a.id,'sent','ref-e',null);
 if d.status<>'cancelled' then raise exception 'Cancelled consultation revived'; end if;
end $$;
do $$
declare ctx jsonb := current_setting('stetholink.context')::jsonb; n integer; t text; invalid jsonb;
begin
 if (select count(*) from public.consultation_provider_responses)<4 then raise exception 'Clinician cannot read back responses'; end if;
 foreach invalid in array array['{"tenantId":"synthetic-test-b"}'::jsonb,'{"clinicianId":"22222222-2222-4222-8222-222222222222"}'::jsonb,
   '{"patientId":"syn-pt-002"}'::jsonb,'{"encounterId":"other"}'::jsonb,'{"expiresAt":0}'::jsonb] loop
  perform set_config('stetholink.context',(ctx||invalid)::text,true);
  select count(*) into n from public.consultation_provider_responses;
  if n<>0 then raise exception 'Cross-scope response read allowed'; end if;
  begin
   perform public.record_ehr_dispatch_result((select id from public.consultation_delivery_attempts limit 1),'sent','x',null);
   raise exception using errcode='XX000',message='Cross-scope dispatch result accepted';
  exception when no_data_found or invalid_parameter_value then null; end;
 end loop;
 perform set_config('stetholink.context',ctx::text,true);
 foreach t in array array['consultation_provider_responses','consultation_delivery_attempts'] loop
  if has_table_privilege(current_user,'public.'||t,'insert') or has_table_privilege(current_user,'public.'||t,'update')
    or has_table_privilege(current_user,'public.'||t,'delete') then raise exception 'Runtime can forge or alter %',t; end if;
 end loop;
end $$;
reset session authorization;
do $$ begin
 if not (select relrowsecurity from pg_class where oid='public.consultation_provider_responses'::regclass)
  or has_table_privilege('anon','public.consultation_provider_responses','select')
  or has_table_privilege('authenticated','public.consultation_provider_responses','select')
  or has_function_privilege('anon','public.record_provider_callback(text,uuid,text,text,text,jsonb)','execute')
  or has_function_privilege('authenticated','public.dispatch_ehr_consultation(text,integer,text,text,jsonb)','execute')
  then raise exception 'Browser role can reach provider routing'; end if;
 -- The callback function refuses any caller that is not the runtime service role.
 begin
  perform public.record_provider_callback('synthetic-test-a',gen_random_uuid(),'team-a','x','accepted','{"syntheticOnly":true}');
  raise exception using errcode='XX000',message='Non-runtime caller accepted';
 exception when insufficient_privilege then null; end;
end $$;
rollback;
