-- Owner connection to disposable PostgreSQL; all test changes roll back.
begin;
do $$ begin
 if (select status from public.consultation_drafts where id='syn-m3-legacy')<>'pending_review'
  or (select version from public.consultation_drafts where id='syn-m3-legacy')<>2
  or (select count(*) from public.consultation_revisions where draft_id='syn-m3-legacy')<>2
  or (select status from public.consultation_drafts where id='syn-m3-tenantless')<>'pending_approval'
  or (select status from public.consultation_drafts where id='syn-m3-approved')<>'approved'
  then raise exception 'Non-destructive upgrade failed'; end if;
end $$;
set session authorization stetholink_runtime;
select set_config('stetholink.context',jsonb_build_object(
 'clinicianId','11111111-1111-4111-8111-111111111111','tenantId','synthetic-test-a',
 'patientId','syn-pt-001','encounterId','syn-enc-001','roles','["physician"]'::jsonb,
 'scopes','["consultation:draft","consultation:approve"]'::jsonb,'authorization','active',
 'expiresAt',(extract(epoch from now())*1000)::bigint+600000)::text,true);
select set_config('stetholink.recipients','["team-a","team-b"]',true);
do $$
declare
 d public.consultation_drafts%rowtype;
 saved public.consultation_drafts%rowtype;
 ctx jsonb := current_setting('stetholink.context')::jsonb;
 invalid jsonb;
 t text;
 n integer;
begin
 if exists(select 1 from public.consultation_drafts where id='syn-m3-tenantless') then raise exception 'Tenantless history exposed'; end if;
 select * into d from public.create_ehr_consultation(
  '{"id":"syn-m3-create","patientId":"syn-pt-001","encounterId":"syn-enc-001","status":"pending_approval", "summary":"Synthetic summary","assessment":"Synthetic assessment","plan":[],
    "grounding":{"question":null,"specialty":null,"reason":null,"gaps":["Unknown investigation"],"conflicts":[],"evidenceIds":[],
    "provenance":{"syntheticOnly":true,"provider":"mock","model":"mock-1","promptVersion":"test","encounterReference":null}},
    "clinicalFacts":[],"missingInformation":[]}'::jsonb,
  '{"patientId":"syn-pt-001","encounterId":"syn-enc-001"}'::jsonb,'create-1');
 if d.status<>'pending_review' or d.version<>1
  or d.clinical_metadata->'grounding'->'question' is distinct from 'null'::jsonb
  or d.clinical_metadata->'grounding'->'provenance'->'encounterReference' is distinct from 'null'::jsonb
  or d.clinical_metadata ? 'attachments'
  then raise exception 'Typed metadata unknown values or optional fields corrupted'; end if;
 select * into saved from public.create_ehr_consultation(
  '{"id":"syn-m3-retry"}'::jsonb,'{"patientId":"syn-pt-001","encounterId":"syn-enc-001"}'::jsonb,'create-1');
 if to_jsonb(d)<>to_jsonb(saved) then raise exception 'Create replay changed stored metadata'; end if;
 select * into d from public.record_ehr_consultation_approval('syn-m3-legacy','request_changes',null);
 if d.status<>'draft' or d.version<>3 then raise exception 'Legacy approval signature broken'; end if;
 select * into saved from public.change_ehr_consultation(d.id,'revise',d.version,'edit-1','{"summary":"Revised synthetic summary","assessment":"Synthetic assessment","plan":[]}'::jsonb);
 if saved.version<>4 or saved.reviewed_by is not null then raise exception 'Revision failed'; end if;
 select * into d from public.change_ehr_consultation(d.id,'revise',3,'edit-1','{"summary":"Revised synthetic summary","assessment":"Synthetic assessment","plan":[]}'::jsonb);
 if to_jsonb(d)<>to_jsonb(saved) then raise exception 'Replay changed response'; end if;
 begin
  perform public.change_ehr_consultation(d.id,'revise',3,'stale-edit','{"summary":"Lost update","assessment":"","plan":[]}');
  raise exception using errcode='XX000',message='Stale edit accepted';
 exception when raise_exception then null; end;
 begin
  perform public.change_ehr_consultation(d.id,'cancel',4,'edit-1','{}');
  raise exception using errcode='XX000',message='Conflicting key accepted';
 exception when raise_exception then null; end;
 begin
  perform public.change_ehr_consultation(d.id,'approve',4,'ai-approve','{}');
  raise exception using errcode='XX000',message='Lifecycle can approve';
 exception when invalid_parameter_value then null; end;
 begin
  perform public.approve_ehr_consultation_versioned(d.id,'approve',null,4,'approve-without-submit');
  raise exception using errcode='XX000',message='Draft approved without submit';
 exception when raise_exception then null; end;
 select * into d from public.change_ehr_consultation(d.id,'submit',4,'submit-1','{}');
 select * into d from public.approve_ehr_consultation_versioned(d.id,'approve',null,5,'approval-1');
 if d.version<>6 or d.status<>'approved' then raise exception 'Physician approval failed'; end if;
 begin
  perform public.change_ehr_consultation(d.id,'queue',6,'forbidden-recipient','{"recipientId":"evil"}');
  raise exception using errcode='XX000',message='Recipient allowlist bypassed';
 exception when insufficient_privilege then null; end;
 select * into d from public.change_ehr_consultation(d.id,'queue',6,'queue-1','{"recipientId":"team-a"}');
 select * into d from public.change_ehr_consultation(d.id,'failed',7,'failed-1','{}');
 begin
  perform public.change_ehr_consultation(d.id,'queue',8,'redirect','{"recipientId":"team-b"}');
  raise exception using errcode='XX000',message='Retry recipient redirected';
 exception when raise_exception then null; end;
 select * into d from public.change_ehr_consultation(d.id,'queue',8,'queue-2','{"recipientId":"team-a"}');
 select * into d from public.change_ehr_consultation(d.id,'sent',9,'sent-1','{}');
 select * into d from public.change_ehr_consultation(d.id,'accepted',10,'accepted-1','{}');
 select * into d from public.change_ehr_consultation(d.id,'responded',11,'responded-1','{}');
 if d.status<>'responded' or d.version<>12 or (select count(*) from public.consultation_delivery_attempts where draft_id=d.id)<>2
  then raise exception 'Mock attempt history incorrect'; end if;
 select * into saved from public.approve_ehr_consultation_versioned(d.id,'approve',null,5,'approval-1');
 if saved.status<>'approved' or saved.version<>6 then raise exception 'Replay did not preserve original snapshot'; end if;
 if (select count(*) from public.consultation_events where draft_id=d.id)<>12 then raise exception 'History is incomplete'; end if;
 foreach invalid in array array[
  '{"tenantId":"synthetic-test-b"}'::jsonb,'{"clinicianId":"22222222-2222-4222-8222-222222222222"}'::jsonb,
  '{"patientId":"syn-pt-002"}'::jsonb,'{"encounterId":"other"}'::jsonb,'{"expiresAt":0}'::jsonb,
  '{"authorization":"revoked"}'::jsonb
 ] loop
  perform set_config('stetholink.context',(ctx||invalid)::text,true);
  foreach t in array array['consultation_drafts','consultation_revisions','consultation_events','consultation_delivery_attempts','consultation_idempotency','consultation_approvals'] loop
   execute format('select count(*) from public.%I',t) into n;
   if n<>0 then raise exception 'Cross-scope read allowed on %',t; end if;
  end loop;
  begin
   perform public.approve_ehr_consultation_versioned(d.id,'approve',null,5,'approval-1');
   raise exception using errcode='XX000',message='Cross-scope replay permitted';
  exception
   when no_data_found then
    if invalid ? 'expiresAt' or invalid ? 'authorization' then raise; end if;
   when insufficient_privilege then
    if not (invalid ? 'expiresAt' or invalid ? 'authorization') then raise; end if;
  end;
 end loop;
 perform set_config('stetholink.context',(ctx||'{"roles":["clinician"]}')::text,true);
 begin
  perform public.approve_ehr_consultation_versioned(d.id,'approve',null,5,'approval-1');
  raise exception using errcode='XX000',message='Non-physician replay allowed';
 exception when insufficient_privilege then null; end;
 perform set_config('stetholink.context',ctx::text,true);
 foreach t in array array['consultation_drafts','consultation_revisions','consultation_events','consultation_delivery_attempts','consultation_idempotency','consultation_approvals'] loop
  if has_table_privilege(current_user,'public.'||t,'update') or has_table_privilege(current_user,'public.'||t,'delete')
   then raise exception 'Mutable runtime history on %',t; end if;
 end loop;
 if has_function_privilege(current_user,'stetholink_private.consultation_command(text,text,integer,text,jsonb)','execute')
  then raise exception 'Private command engine exposed'; end if;
end $$;
reset session authorization;
do $$ declare t text; begin
 foreach t in array array['consultation_drafts','consultation_revisions','consultation_events','consultation_delivery_attempts','consultation_idempotency','consultation_approvals'] loop
  if not (select relrowsecurity from pg_class where oid=('public.'||t)::regclass)
   or has_table_privilege('anon','public.'||t,'select') or has_table_privilege('authenticated','public.'||t,'select')
   then raise exception 'Browser role access or RLS regression on %',t; end if;
 end loop;
end $$;
rollback;
