-- Execute as the database owner on an isolated staging database. Test rows roll back.
begin;
set session authorization stetholink_runtime;
select set_config('stetholink.context', jsonb_build_object(
 'clinicianId', '11111111-1111-4111-8111-111111111111', 'tenantId', 'synthetic-test-a',
 'patientId', 'syn-pt-001', 'encounterId', 'syn-enc-001', 'roles', '["physician"]'::jsonb,
 'scopes', '["consultation:draft","consultation:approve"]'::jsonb, 'authorization', 'active',
 'expiresAt', (extract(epoch from now()) * 1000)::bigint + 60000)::text, true);
insert into public.consultation_drafts(id,tenant_id,patient_id,encounter_id,status,clinician_id,provider,model,prompt_version)
 values ('syn-rls-verification','synthetic-test-a','syn-pt-001','syn-enc-001','pending_approval',
 '11111111-1111-4111-8111-111111111111','mock','mock','test');

do $$
declare
 ctx jsonb := current_setting('stetholink.context')::jsonb;
 invalid jsonb;
begin
 if (select count(*) from public.consultation_drafts where id='syn-rls-verification') <> 1 then
   raise exception 'Owner cannot read';
 end if;
 begin
   update public.consultation_drafts set status='approved' where id='syn-rls-verification';
   raise exception 'Direct update allowed';
 exception when insufficient_privilege then null; end;
 begin
   insert into public.consultation_drafts(id,tenant_id,patient_id,encounter_id,status,clinician_id,provider,model,prompt_version)
    values ('syn-forged','synthetic-test-a','syn-pt-001','syn-enc-001','approved',
    '11111111-1111-4111-8111-111111111111','mock','mock','test');
   raise exception 'Forged approval allowed';
 exception when insufficient_privilege then null; end;
 foreach invalid in array array[
   '{"tenantId":"synthetic-test-b"}'::jsonb, '{"patientId":"syn-pt-002"}'::jsonb,
   '{"encounterId":"syn-enc-002"}'::jsonb, '{"clinicianId":"22222222-2222-4222-8222-222222222222"}'::jsonb,
   '{"expiresAt":0}'::jsonb
 ] loop
   perform set_config('stetholink.context', (ctx || invalid)::text, true);
   if exists (select 1 from public.consultation_drafts where id='syn-rls-verification') then
     raise exception 'Unscoped read allowed';
   end if;
   begin
     perform public.record_ehr_consultation_approval('syn-rls-verification','approve',null);
     raise exception 'Unscoped approval allowed';
   exception
     when no_data_found then
       if invalid ? 'expiresAt' then raise exception 'Expired chart did not fail authorization'; end if;
     when insufficient_privilege then
       -- M3 checks active authorization before looking up the scoped aggregate.
       if not (invalid ? 'expiresAt') then raise; end if;
   end;
 end loop;
 perform set_config('stetholink.context', (ctx || '{"roles":["clinician"]}')::text, true);
 begin
   perform public.record_ehr_consultation_approval('syn-rls-verification','approve',null);
   raise exception 'Non-physician approval allowed';
 exception when insufficient_privilege then null; end;
 perform set_config('stetholink.context', ctx::text, true);
 perform public.record_ehr_consultation_approval('syn-rls-verification','request_changes',null);
 perform public.record_ehr_consultation_approval('syn-rls-verification','approve',null);
 begin
   perform public.record_ehr_consultation_approval('syn-rls-verification','approve',null);
   raise exception using errcode='XX000', message='Duplicate approval allowed';
 exception when raise_exception then null; end;
 if has_table_privilege(current_user,'public.consultation_approvals','delete') then raise exception 'Audit deletion allowed'; end if;
end $$;

reset session authorization;
do $$ begin
 if (select count(*) from public.consultation_approvals where draft_id='syn-rls-verification') <> 2 then
   raise exception 'Approval audit count incorrect';
 end if;
 if has_table_privilege('anon','public.consultation_drafts','select')
   or has_table_privilege('authenticated','public.consultation_drafts','select')
   or has_function_privilege('authenticated','public.record_consultation_approval(text,text,text)','execute')
   or has_function_privilege('authenticated','public.record_ehr_consultation_approval(text,text,text)','execute') then
   raise exception 'Legacy or anonymous authorization allowed';
 end if;
end $$;
rollback;
