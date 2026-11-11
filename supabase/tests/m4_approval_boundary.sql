-- Run after M4 against disposable PostgreSQL. Every row and permission test rolls back.
begin;
set session authorization stetholink_runtime;
select set_config('stetholink.context', jsonb_build_object(
 'clinicianId','11111111-1111-4111-8111-111111111111','tenantId','synthetic-test-a',
 'patientId','syn-pt-001','encounterId','syn-enc-001','roles','["physician"]'::jsonb,
 'scopes','["chart:read","consultation:draft","consultation:approve","consultation:route"]'::jsonb,
 'authorization','active','expiresAt',(extract(epoch from now())*1000)::bigint+600000)::text,true);
select set_config('stetholink.recipients','["team-a","team-b"]',true);

do $$
declare
 ctx jsonb := current_setting('stetholink.context')::jsonb;
 claims jsonb;
 d public.consultation_drafts%rowtype;
 replay public.consultation_drafts%rowtype;
 id text := 'syn-m4-test';
begin
 if has_function_privilege(current_user,'public.record_ehr_consultation_approval(text,text,text)','execute')
   or has_function_privilege(current_user,'public.approve_ehr_consultation_versioned(text,text,text,integer,text)','execute')
   or has_table_privilege(current_user,'public.consultation_drafts','insert')
   or has_table_privilege(current_user,'public.consultation_approvals','insert,select')
   or has_table_privilege(current_user,'public.consultation_idempotency','select') then
  raise exception 'Unexpected runtime write privilege';
 end if;
 if (select status from public.consultation_drafts where consultation_drafts.id='syn-m3-approved') is distinct from 'pending_review' then
  raise exception 'Legacy approval was not returned to review';
 end if;
 select * into d from public.create_ehr_consultation(
  '{"id":"syn-m4-test","patientId":"syn-pt-001","encounterId":"syn-enc-001","status":"pending_approval",
   "summary":"Synthetic summary","assessment":"Synthetic assessment","plan":[],
   "grounding":{"provenance":{"syntheticOnly":true,"provider":"mock","model":"mock","promptVersion":"test"}}}',
  '{"patientId":"syn-pt-001","encounterId":"syn-enc-001"}','m4-create');

 foreach claims in array array[
  '{"tenantId":"synthetic-test-b"}'::jsonb, '{"patientId":"syn-pt-002"}'::jsonb,
  '{"encounterId":"syn-enc-002"}'::jsonb, '{"clinicianId":"22222222-2222-4222-8222-222222222222"}'::jsonb
 ] loop
  perform set_config('stetholink.context',(ctx||claims)::text,true);
  if exists(select 1 from public.consultation_drafts where consultation_drafts.id=d.id) then
   raise exception 'Cross-context read';
  end if;
  begin
   perform public.review_ehr_consultation(id,'approve','team-a',1,'m4-review');
   raise exception 'Cross-context approval';
  exception when no_data_found then null; end;
  begin
   perform public.dispatch_ehr_consultation(id,'team-a',1,'m4-send');
   raise exception 'Cross-context dispatch';
  exception when no_data_found then null; end;
 end loop;

 foreach claims in array array[
  '{"expiresAt":0}'::jsonb, '{"roles":["clinician"]}'::jsonb, '{"scopes":["chart:read","consultation:draft"]}'::jsonb
 ] loop
  perform set_config('stetholink.context',(ctx||claims)::text,true);
  begin
   perform public.review_ehr_consultation(id,'approve','team-a',1,'m4-review');
   raise exception 'Unauthorized review';
  exception when insufficient_privilege then null; end;
  begin
   perform public.dispatch_ehr_consultation(id,'team-a',1,'m4-send');
   raise exception 'Unauthorized dispatch';
  exception when insufficient_privilege then null; end;
 end loop;
 perform set_config('stetholink.context',ctx::text,true);

 begin
  perform public.dispatch_ehr_consultation(id,'team-a',1,'m4-send');
  raise exception using errcode='XX000',message='Dispatch without approval';
 exception when raise_exception then null; end;
 begin
  perform public.review_ehr_consultation(id,'approve','forbidden',1,'m4-review');
  raise exception 'Approval for non-allowlisted recipient';
 exception when insufficient_privilege then null; end;
 select * into d from public.review_ehr_consultation(id,'approve','team-a',1,'m4-review');
 if d.status <> 'approved' or d.approved_recipient_id is distinct from 'team-a' then
  raise exception 'Approval destination not recorded';
 end if;
 begin
  perform public.dispatch_ehr_consultation(id,'team-b',2,'m4-send');
  raise exception 'Allowed but unapproved destination';
 exception when insufficient_privilege then null; end;
 begin
  perform public.review_ehr_consultation(id,'approve','team-b',1,'m4-review');
  raise exception using errcode='XX000',message='Review replay accepted changed destination';
 exception when raise_exception then null; end;

 select * into d from public.change_ehr_consultation(id,'queue',2,'m4-queue','{"recipientId":"team-a"}');
 perform set_config('stetholink.recipients','["team-b"]',true);
 begin
  perform public.change_ehr_consultation(id,'sent',3,'m4-send','{}');
  raise exception 'Removed destination sent from queued attempt';
 exception when insufficient_privilege then null; end;
 perform set_config('stetholink.recipients','["team-a","team-b"]',true);
 select * into d from public.change_ehr_consultation(id,'sent',3,'m4-send','{}');
 select * into replay from public.change_ehr_consultation(id,'sent',3,'m4-send','{}');
 if to_jsonb(d) is distinct from to_jsonb(replay) or d.status <> 'sent' then
  raise exception 'Dispatch replay did not return its original result';
 end if;
 perform public.change_ehr_consultation(id,'failed',4,'m4-failure','{}');
 begin
  perform public.dispatch_ehr_consultation(id,'team-a',5,'m4-new-send');
  raise exception using errcode='XX000',message='Previously sent attempt dispatched again';
 exception when raise_exception then null; end;
 if (select count(*) from public.consultation_delivery_attempts a
     where a.draft_id=d.id and a.approval_version=2 and a.recipient_id='team-a' and a.sent_at is not null) <> 1
   or (select count(*) from public.consultation_events e where e.draft_id=d.id and e.to_status='sent') <> 1 then
  raise exception 'Audit did not preserve one approved send';
 end if;

 foreach claims in array array['{"tenantId":"synthetic-test-b"}'::jsonb,'{"expiresAt":0}'::jsonb] loop
  perform set_config('stetholink.context',(ctx||claims)::text,true);
  begin
   perform public.change_ehr_consultation(id,'sent',3,'m4-send','{}');
   raise exception 'Unauthorized replay returned stored data';
  exception when no_data_found or insufficient_privilege then null; end;
 end loop;
end $$;

reset session authorization;
do $$ begin
 if (select count(*) from public.consultation_approvals a where a.draft_id='syn-m4-test'
      and a.version=2 and a.decision='approve' and a.recipient_id='team-a' and a.comment is null) <> 1 then
  raise exception 'Approval audit is missing or includes unnecessary text';
 end if;
 if has_function_privilege('anon','public.review_ehr_consultation(text,text,text,integer,text)','execute')
   or has_function_privilege('authenticated','public.dispatch_ehr_consultation(text,text,integer,text)','execute') then
  raise exception 'Browser can execute privileged commands';
 end if;
 begin
  update public.consultation_approvals set recipient_id='team-b' where draft_id='syn-m4-test';
  raise exception 'Approval audit changed';
 exception when insufficient_privilege then null; end;
 begin
  delete from public.consultation_events where draft_id='syn-m4-test';
  raise exception 'Event audit deleted';
 exception when insufficient_privilege then null; end;
 begin
  truncate public.consultation_revisions;
  raise exception 'Revision history truncated';
 exception when insufficient_privilege then null; end;
end $$;
rollback;
