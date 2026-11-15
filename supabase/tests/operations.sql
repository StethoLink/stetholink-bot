-- Owner connection to disposable PostgreSQL; all test changes roll back. Fictional data only.
begin;
create function pg_temp.refused(p_label text,p_state text,p_sql text) returns void language plpgsql as $$
declare outcome text := 'accepted';
begin
 begin execute p_sql; exception when others then outcome := sqlstate; end;
 if outcome <> p_state then raise exception 'Expected % for "%", got %',p_state,p_label,outcome; end if;
end $$;
create function pg_temp.expect(p_label text,p_ok boolean) returns void language plpgsql as $$
begin if not coalesce(p_ok,false) then raise exception 'Failed: %',p_label; end if; end $$;

-- Working rows that have outlived their period, created as the owner.
insert into stetholink_private.browser_sessions(handle_hash,kind,tenant_id,payload,expires_at) values
 ('expired-handle','session','fictional-tenant','{"sealed":"v1"}',now()-interval '1 hour'),('current-handle','session','fictional-tenant','{"sealed":"v1"}',now()+interval '10 minutes');
insert into public.scribe_sessions(id,tenant_id,clinician_id,patient_id,encounter_id,data_classification,consent_confirmed_at,consent_statement,spoken_language,note_language,transcript_expires_at,status,updated_at) values
 ('11111111-1111-4111-8111-000000000001','fictional-tenant','55555555-5555-4555-8555-555555555555','fic-pt-1','fic-enc-1','live',now()-interval '9 days','The clinician confirmed that the patient agreed.','ar-SA','en',now()-interval '2 days','note_ready',now()-interval '9 days'),
 ('11111111-1111-4111-8111-000000000002','fictional-tenant','55555555-5555-4555-8555-555555555555','fic-pt-1','fic-enc-1','live',now()-interval '1 hour','The clinician confirmed that the patient agreed.','ar-SA','en',now()+interval '6 days','recording',now()),
 ('11111111-1111-4111-8111-000000000003','fictional-tenant','55555555-5555-4555-8555-555555555555','fic-pt-1','fic-enc-1','live',now()-interval '90 days','The clinician confirmed that the patient agreed.','ar-SA','en',now()-interval '83 days','discarded',now()-interval '90 days');
-- A discarded visit has no transcript any more.
update public.scribe_sessions set transcript_deleted_at=now()-interval '90 days' where id='11111111-1111-4111-8111-000000000003';
insert into public.scribe_segments(session_id,chunk_index,seq,started_ms,ended_ms,content) values
 ('11111111-1111-4111-8111-000000000001',0,0,0,1000,'جملة خيالية قديمة'),('11111111-1111-4111-8111-000000000002',0,0,0,1000,'جملة خيالية حديثة');
insert into public.scribe_events(session_id,tenant_id,clinician_id,event_type) values ('11111111-1111-4111-8111-000000000003','fictional-tenant','55555555-5555-4555-8555-555555555555','discarded');

do $$
declare n integer; r jsonb; id1 bigint; id2 bigint;
begin
 -- Spend ledger: the runtime role reserves against one tenant total and cannot read or edit the ledger.
 set session authorization stetholink_runtime;
 id1 := public.reserve_spend('fictional-tenant','model','scribe_soap_note',0.60,1.00);
 id2 := public.reserve_spend('fictional-tenant','transcription','transcription',0.30,1.00);
 perform pg_temp.refused('over the daily limit','P0001','select public.reserve_spend(''fictional-tenant'',''model'',''consultation_referral'',0.20,1.00)');
 perform pg_temp.refused('negative amount','22023','select public.reserve_spend(''fictional-tenant'',''model'',''x'',-1,1.00)');
 perform public.settle_spend(id1,0.05);
 -- The first call cost less than reserved, so there is room again; another tenant has its own total.
 perform public.reserve_spend('fictional-tenant','model','consultation_referral',0.20,1.00);
 perform public.reserve_spend('another-fictional-tenant','model','consultation_referral',0.90,1.00);
 -- Settling twice, or for more than was reserved, changes nothing further.
 perform public.settle_spend(id1,5.00);
 perform public.settle_spend(id2,5.00);
 perform pg_temp.refused('read the ledger','42501','select count(*) from stetholink_private.usage_ledger');
 perform pg_temp.refused('retention by the application','42501','select public.run_retention(1,1,1)');
 reset session authorization;
 select count(*) into n from stetholink_private.usage_ledger where tenant_id='fictional-tenant' and actual_usd=0.05; perform pg_temp.expect('first settlement kept', n = 1);
 select count(*) into n from stetholink_private.usage_ledger where tenant_id='fictional-tenant' and actual_usd=0.30; perform pg_temp.expect('settlement capped at the reservation', n = 1);

 -- Retention as the maintenance login.
 set session authorization stetholink_maintenance;
 perform pg_temp.refused('period below one day','22023','select public.run_retention(0,null,null)');
 perform pg_temp.refused('maintenance cannot read clinical tables directly','42501','select count(*) from public.scribe_sessions');
 r := public.run_retention(null,null,null);
 reset session authorization;
 perform pg_temp.expect('one expired session removed', (r->>'expiredSessions')::int = 1);
 perform pg_temp.expect('one transcript expired', (r->>'transcriptsDeleted')::int = 1);
 select count(*) into n from stetholink_private.browser_sessions; perform pg_temp.expect('current session kept', n = 1);
 select count(*) into n from public.scribe_segments; perform pg_temp.expect('only the current transcript remains', n = 1);
 select count(*) into n from public.scribe_events where event_type='transcript_deleted' and detail->>'reason'='expired'; perform pg_temp.expect('expiry is audited', n = 1);
 select count(*) into n from public.scribe_sessions; perform pg_temp.expect('no visit removed without a period', n = 3);

 set session authorization stetholink_maintenance;
 r := public.run_retention(30,365,400);
 reset session authorization;
 perform pg_temp.expect('the old discarded visit is removed', (r->>'visitsDeleted')::int = 1);
 select count(*) into n from public.scribe_sessions; perform pg_temp.expect('recent and unfinished visits are kept', n = 2);
 select count(*) into n from public.scribe_events where session_id='11111111-1111-4111-8111-000000000003'; perform pg_temp.expect('its audit trail went with it', n = 0);
 -- The audit tables are still closed to everyone outside the retention function.
 perform pg_temp.refused('owner edits consultation history','42501','update public.consultation_events set version=version');
end $$;
rollback;
