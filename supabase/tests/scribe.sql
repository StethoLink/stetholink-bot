-- Owner connection to disposable PostgreSQL; all test changes roll back.
-- Fictional data only: no identifier or statement here describes a real person.
begin;
create function pg_temp.refused(p_label text,p_state text,p_sql text) returns void language plpgsql as $$
declare outcome text := 'accepted';
begin
 begin execute p_sql; exception when others then outcome := sqlstate; end;
 if outcome <> p_state then raise exception 'Expected % for "%", got %',p_state,p_label,outcome; end if;
end $$;
create function pg_temp.session(p_context jsonb) returns void language sql as $$
 select set_config('stetholink.context',(p_context||jsonb_build_object('expiresAt',(extract(epoch from now())*1000)::bigint+600000))::text,true);
$$;
create function pg_temp.expect(p_label text,p_ok boolean) returns void language plpgsql as $$
begin if not coalesce(p_ok,false) then raise exception 'Failed: %',p_label; end if; end $$;
set session authorization stetholink_runtime;

do $$
declare
 physician jsonb := jsonb_build_object('clinicianId','55555555-5555-4555-8555-555555555555','tenantId','fictional-live-tenant','patientId','fic-pt-1','encounterId','fic-enc-1',
  'roles','["physician"]'::jsonb,'scopes','["chart:read","scribe:record","chart:write","consultation:draft"]'::jsonb,'authorization','active','dataClassification','live');
 nurse jsonb := physician || jsonb_build_object('clinicianId','66666666-6666-4666-8666-666666666666','roles','["clinician"]'::jsonb,'scopes','["chart:read","scribe:record"]'::jsonb);
 visit text := '9f6b7c1e-1c1f-4c58-9a57-0d7f6f0d1a11';
 start_sql text := $q$insert into public.scribe_sessions(id,tenant_id,clinician_id,patient_id,encounter_id,data_classification,consent_confirmed_at,consent_statement,spoken_language,note_language,transcript_expires_at)
  values ('%s','fictional-live-tenant','55555555-5555-4555-8555-555555555555','%s','fic-enc-1','%s',%s,'The clinician confirmed that the patient agreed.','ar-SA','en',clock_timestamp()+interval '7 days')$q$;
 v_note jsonb := '{"sections":{"subjective":[],"objective":[],"assessment":[],"plan":[]},"proposedUpdates":[{"id":"u1","kind":"allergy","name":"Sulfa","relation":"new"},{"id":"u2","kind":"allergy","name":"No drug allergy stated","relation":"conflicts"},{"id":"u3","kind":"medication","name":"Metformin","relation":"already_in_chart"}]}';
 n integer;
begin
 -- Starting: own chart, own classification, the scribe permission and a fresh consent statement.
 perform pg_temp.session(physician - 'scopes' || '{"scopes":["chart:read"]}');
 perform pg_temp.refused('no scribe permission','42501',format(start_sql,visit,'fic-pt-1','live','clock_timestamp()'));
 perform pg_temp.session(physician);
 perform pg_temp.refused('another patient','42501',format(start_sql,visit,'fic-pt-2','live','clock_timestamp()'));
 perform pg_temp.refused('synthetic row in a live session','42501',format(start_sql,visit,'fic-pt-1','synthetic','clock_timestamp()'));
 perform pg_temp.refused('consent given long ago','42501',format(start_sql,visit,'fic-pt-1','live','clock_timestamp()-interval ''1 hour'''));
 execute format(start_sql,visit,'fic-pt-1','live','clock_timestamp()');
 insert into public.scribe_segments(session_id,chunk_index,seq,started_ms,ended_ms,content) values (visit::uuid,0,0,0,4000,'جملة خيالية'),(visit::uuid,0,1,4000,9000,'جملة خيالية ثانية');
 insert into public.scribe_events(session_id,tenant_id,clinician_id,event_type) values (visit::uuid,'fictional-live-tenant','55555555-5555-4555-8555-555555555555','consent_confirmed');

 -- The transcript: the speaker can be corrected, the words cannot; the audit trail is append-only.
 update public.scribe_segments set speaker='patient' where session_id=visit::uuid and seq=1;
 perform pg_temp.refused('edit transcript words','42501',format($q$update public.scribe_segments set content='كلام آخر' where session_id='%s'$q$,visit));
 perform pg_temp.refused('edit audit','42501','update public.scribe_events set detail=''{"x":1}''');
 perform pg_temp.refused('delete audit','42501','delete from public.scribe_events');
 perform pg_temp.refused('forge an approval event','42501',format($q$insert into public.scribe_events(session_id,tenant_id,clinician_id,event_type) values ('%s','fictional-live-tenant','55555555-5555-4555-8555-555555555555','note_approved')$q$,visit));

 -- Another clinician, chart or tenant sees nothing.
 perform pg_temp.session(nurse);
 select count(*) into n from public.scribe_sessions; perform pg_temp.expect('other clinician sees no visit', n = 0);
 select count(*) into n from public.scribe_segments; perform pg_temp.expect('other clinician sees no transcript', n = 0);
 perform pg_temp.session(physician || '{"patientId":"fic-pt-2"}');
 select count(*) into n from public.scribe_sessions; perform pg_temp.expect('other chart sees no visit', n = 0);
 perform pg_temp.session(physician || '{"dataClassification":"synthetic"}');
 select count(*) into n from public.scribe_sessions; perform pg_temp.expect('other classification sees no visit', n = 0);

 -- Approval cannot be set directly, only through the physician command.
 perform pg_temp.session(physician);
 update public.scribe_sessions set status='note_ready', note=v_note, note_version=1 where id=visit::uuid;
 perform pg_temp.refused('approve by direct update','42501',format($q$update public.scribe_sessions set status='approved', approved_by=clinician_id, approved_at=now(), approval='{}' where id='%s'$q$,visit));
 perform pg_temp.refused('nothing may be written before approval','42501',format($q$select public.begin_chart_write('scribe_note','%s','sl-9f6b7c1e1c1f4c589a570d7f6f0d1a11-note','DocumentReference')$q$,visit));
 perform pg_temp.refused('wrong version','P0001',format($q$select public.approve_scribe_note('%s',2,'{"note":true,"updates":[]}')$q$,visit));
 perform pg_temp.refused('conflicting item','P0001',format($q$select public.approve_scribe_note('%s',1,'{"note":true,"updates":["u2"]}')$q$,visit));
 perform pg_temp.refused('item already in chart','P0001',format($q$select public.approve_scribe_note('%s',1,'{"note":true,"updates":["u3"]}')$q$,visit));
 perform pg_temp.refused('item not in the note','P0001',format($q$select public.approve_scribe_note('%s',1,'{"note":true,"updates":["u9"]}')$q$,visit));
 perform pg_temp.session(physician || '{"roles":["clinician"]}');
 perform pg_temp.refused('non-physician approval','42501',format($q$select public.approve_scribe_note('%s',1,'{"note":true,"updates":["u1"]}')$q$,visit));
 perform pg_temp.session(physician - 'scopes' || '{"scopes":["chart:read","scribe:record"]}');
 perform pg_temp.refused('no chart:write permission','42501',format($q$select public.approve_scribe_note('%s',1,'{"note":true,"updates":["u1"]}')$q$,visit));
 perform pg_temp.session(physician);
 perform public.approve_scribe_note(visit::uuid,1,'{"note":true,"updates":["u1"]}');
 perform public.approve_scribe_note(visit::uuid,1,'{"note":true,"updates":["u1"]}');
 perform pg_temp.refused('a different second approval','P0001',format($q$select public.approve_scribe_note('%s',1,'{"note":false,"updates":["u1"]}')$q$,visit));
 select count(*) into n from public.scribe_events where event_type='note_approved'; perform pg_temp.expect('one approval event', n = 1);
 -- After approval the row is closed to direct edits: the update touches nothing.
 update public.scribe_sessions set note='{}' where id=visit::uuid;
 select count(*) into n from public.scribe_sessions where note='{}'; perform pg_temp.expect('approved note is unchanged', n = 0);

 -- The ledger opens only for what was approved, for this chart, once.
 perform public.begin_chart_write('scribe_note',visit,'sl-9f6b7c1e1c1f4c589a570d7f6f0d1a11-note','DocumentReference');
 perform public.begin_chart_write('scribe_update',visit,'sl-9f6b7c1e1c1f4c589a570d7f6f0d1a11-u1','AllergyIntolerance');
 perform pg_temp.refused('item that was not selected','42501',format($q$select public.begin_chart_write('scribe_update','%s','sl-9f6b7c1e1c1f4c589a570d7f6f0d1a11-u3','MedicationStatement')$q$,visit));
 perform pg_temp.refused('note as another resource','42501',format($q$select public.begin_chart_write('scribe_note','%s','sl-9f6b7c1e1c1f4c589a570d7f6f0d1a11-x','Condition')$q$,visit));
 perform pg_temp.refused('reuse a key for another resource type','42501',format($q$select public.begin_chart_write('scribe_update','%s','sl-9f6b7c1e1c1f4c589a570d7f6f0d1a11-u1','Condition')$q$,visit));
 perform pg_temp.session(nurse);
 perform pg_temp.refused('non-physician write','42501',format($q$select public.begin_chart_write('scribe_note','%s','sl-9f6b7c1e1c1f4c589a570d7f6f0d1a11-note','DocumentReference')$q$,visit));
 perform pg_temp.session(physician);
 perform pg_temp.refused('direct insert into the ledger','42501','insert into public.chart_writes(tenant_id,clinician_id,patient_id,encounter_id,data_classification,origin_kind,origin_id,item_key,resource_type) values (''t'',''55555555-5555-4555-8555-555555555555'',''p'',''e'',''live'',''scribe_note'',''x'',''sl-00000000-note'',''DocumentReference'')');
 perform public.record_chart_write('sl-9f6b7c1e1c1f4c589a570d7f6f0d1a11-note','created','fic-doc-1',null);
 -- A recorded success is final.
 perform public.record_chart_write('sl-9f6b7c1e1c1f4c589a570d7f6f0d1a11-note','failed',null,'late failure');
 select count(*) into n from public.chart_writes where status='created' and resource_id='fic-doc-1'; perform pg_temp.expect('success is kept', n = 1);
 select count(*) into n from public.chart_writes; perform pg_temp.expect('two ledger rows', n = 2);

 -- Once the note is in the chart the transcript is deleted and the visit is closed.
 perform public.finish_scribe_session(visit::uuid,'{"noteInChart":true,"created":1,"existing":0,"failed":1,"unsupported":0}');
 select count(*) into n from public.scribe_segments; perform pg_temp.expect('transcript deleted', n = 0);
 select count(*) into n from public.scribe_sessions where status='written' and transcript_deleted_at is not null; perform pg_temp.expect('visit written', n = 1);
 select count(*) into n from public.scribe_events where event_type in ('chart_write','transcript_deleted'); perform pg_temp.expect('write and deletion audited', n = 2);
end $$;
rollback;
