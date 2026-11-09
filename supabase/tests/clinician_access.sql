begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","app_metadata":{"role":"clinician"},"is_anonymous":false}', true);
insert into public.consultation_drafts(id,patient_id,status,clinician_id,provider,model,prompt_version)
 values ('syn-rls-verification','syn-pt-001','pending_approval','11111111-1111-4111-8111-111111111111','mock','mock-1','test');
do $$ begin
 if (select count(*) from public.consultation_drafts where id='syn-rls-verification') <> 1 then raise exception 'owner cannot read'; end if;
 begin
 update public.consultation_drafts set status='approved' where id='syn-rls-verification';
 raise exception 'direct update allowed';
 exception when insufficient_privilege then null; end;
 begin
 insert into public.consultation_drafts(id,patient_id,status,clinician_id,provider,model,prompt_version)
 values ('syn-forged','syn-pt-001','approved','11111111-1111-4111-8111-111111111111','mock','mock','test');
 raise exception 'forged approval allowed';
 exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","app_metadata":{"role":"clinician"}}',true);
do $$ begin
 if (select count(*) from public.consultation_drafts where id='syn-rls-verification') <> 0 then raise exception 'cross-user read allowed'; end if;
 begin
 perform public.record_consultation_approval('syn-rls-verification','approve');
 raise exception 'cross-user approval allowed';
 exception when no_data_found then null; end;
end $$;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","app_metadata":{},"user_metadata":{"role":"clinician"}}',true);
do $$ begin
 if (select count(*) from public.consultation_drafts where id='syn-rls-verification') <> 0 then raise exception 'user metadata grants access'; end if;
 begin
 perform public.record_consultation_approval('syn-rls-verification','approve');
 raise exception 'non-clinician approval allowed';
 exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","app_metadata":{"role":"clinician"}}',true);
select * from public.record_consultation_approval('syn-rls-verification','request_changes');
select * from public.record_consultation_approval('syn-rls-verification','approve');
do $$ begin
 if (select count(*) from public.consultation_approvals where draft_id='syn-rls-verification') <> 2 then raise exception 'audit not atomic'; end if;
 begin
 perform public.record_consultation_approval('syn-rls-verification','approve');
 raise exception using errcode='XX000', message='duplicate approval allowed';
 exception when raise_exception then null; end;
 if (select count(*) from public.consultation_approvals where draft_id='syn-rls-verification') <> 2 then raise exception 'duplicate audit'; end if;
 begin
 delete from public.consultation_approvals where draft_id='syn-rls-verification';
 raise exception 'audit deletion allowed';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
 if has_table_privilege('anon','public.consultation_drafts','select') then raise exception 'anon access'; end if;
 if has_function_privilege('anon','public.record_consultation_approval(text,text,text)','execute') then raise exception 'anon RPC'; end if;
end $$;
rollback;
select 'passed: ownership, trusted roles, atomic approval, immutable audit, anonymous denial; synthetic test rows rolled back' as verification;
