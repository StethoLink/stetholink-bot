-- Owner connection to disposable PostgreSQL; all test changes roll back.
-- Fictional data only: no identifier, order or statement here describes a real person.
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
-- A chart fact, an order line and a whole draft payload, as the application builds them.
create function pg_temp.fact(p_id text,p_category text,p_label text,p_type text default 'fhir') returns jsonb language sql as $$
 select jsonb_build_object('id',p_id,'category',p_category,'label',p_label,'status','known','value','fictional',
  'source',jsonb_build_object('type',p_type,'reference','R/'||p_id),'timestamp','2026-01-15T10:00:00.000Z') $$;
create function pg_temp.line(p_id text,p_item text,p_kind text,p_basis text,p_evidence jsonb default '[]',p_flags jsonb default '[]',p_extra jsonb default '{}') returns jsonb language sql as $$
 select jsonb_build_object('id',p_id,'catalogItemId',p_item,'kind',p_kind,'display','Fictional '||p_item,'basis',p_basis,'reason','A fictional reason.',
  'evidenceIds',p_evidence,'flags',p_flags,'status','pending') || p_extra $$;
create function pg_temp.draft(p_id text,p_lines jsonb,p_facts jsonb default null,p_patient text default 'fic-pt-1',p_class text default 'live',p_request text default 'prepare a CBC') returns jsonb language sql as $$
 select jsonb_build_object('id',p_id,'patientId',p_patient,'encounterId','fic-enc-1','mode','case_based','request',p_request,'catalogVersion','fictional-1',
  'lines',p_lines,'unmatched','[]'::jsonb,'notes','[]'::jsonb,
  'clinicalFacts',coalesce(p_facts,jsonb_build_array(pg_temp.fact('f-symptom','symptom','Chest pain'),pg_temp.fact('f-allergy','allergy','Penicillins'))),
  'missingInformation','[]'::jsonb,
  'provenance',jsonb_build_object('provider','fictional','model','fictional-model','promptVersion','order-authoring@1.0.0','dataClassification',p_class,'rejectedLines',1),
  'version',1,'createdAt','2026-01-15T10:00:00.000Z','updatedAt','2026-01-15T10:00:00.000Z') $$;
create function pg_temp.create_sql(p_draft jsonb,p_key text,p_request text default 'prepare a CBC',p_patient text default 'fic-pt-1') returns text language sql as $$
 select format('select public.create_ehr_order_draft(%L::jsonb,%L::jsonb,%L)',p_draft::text,
  jsonb_build_object('patientId',p_patient,'encounterId','fic-enc-1','request',p_request)::text,p_key) $$;
set session authorization stetholink_runtime;

do $$
declare
 physician jsonb := jsonb_build_object('clinicianId','55555555-5555-4555-8555-555555555555','tenantId','fictional-live-tenant','patientId','fic-pt-1','encounterId','fic-enc-1',
  'roles','["physician"]'::jsonb,'scopes','["chart:read","order:draft","order:approve","chart:write"]'::jsonb,'authorization','active','dataClassification','live');
 nurse jsonb := physician || jsonb_build_object('clinicianId','66666666-6666-4666-8666-666666666666','roles','["clinician"]'::jsonb,'scopes','["chart:read","order:draft"]'::jsonb);
 d1 text := '9f6b7c1e-1c1f-4c58-9a57-0d7f6f0d1a11';
 l1 text := 'aaaaaaaa-0000-4000-8000-000000000001';
 l2 text := 'aaaaaaaa-0000-4000-8000-000000000002';
 lines jsonb;
 n integer;
 v_row public.order_drafts%rowtype;
begin
 lines := jsonb_build_array(
  pg_temp.line(l1,'lab-cbc','lab','requested','[]','[]','{"requestedText":"CBC"}'),
  pg_temp.line(l2,'med-amox','medication','proposed','["f-symptom"]','[{"kind":"allergy","text":"A documented allergy.","evidenceIds":["f-allergy"]}]',
   '{"medication":{"product":"Amoxicillin","dose":"500 mg","route":"oral","frequency":"every 8 hours"}}'));

 -- Drafting needs the permission, the verified chart and an unexpired session.
 perform pg_temp.session(physician - 'scopes' || '{"scopes":["chart:read"]}');
 perform pg_temp.refused('no order permission','42501',pg_temp.create_sql(pg_temp.draft(d1,lines),'key-1'));
 perform pg_temp.refused('no order permission lists nothing useful','42501','select * from public.encounter_order_items()');
 perform set_config('stetholink.context',(physician || '{"expiresAt":1}')::text,true);
 perform pg_temp.refused('expired session','42501',pg_temp.create_sql(pg_temp.draft(d1,lines),'key-1'));
 perform set_config('stetholink.context',(physician - 'encounterId' || '{"expiresAt":99999999999999}')::text,true);
 perform pg_temp.refused('no visit','42501',pg_temp.create_sql(pg_temp.draft(d1,lines),'key-1'));
 perform pg_temp.session(physician);

 -- What a draft may carry: this chart, this classification, pending lines, the catalog's kinds, citations the draft holds.
 perform pg_temp.refused('another patient in the draft','22023',pg_temp.create_sql(pg_temp.draft(d1,lines,null,'fic-pt-2'),'key-1'));
 perform pg_temp.refused('another patient in the request','22023',pg_temp.create_sql(pg_temp.draft(d1,lines),'key-1','prepare a CBC','fic-pt-2'));
 perform pg_temp.refused('another request text','22023',pg_temp.create_sql(pg_temp.draft(d1,lines,null,'fic-pt-1','live','something else'),'key-1'));
 perform pg_temp.refused('synthetic draft in a live session','22023',pg_temp.create_sql(pg_temp.draft(d1,lines,null,'fic-pt-1','synthetic'),'key-1'));
 perform pg_temp.refused('synthetic fact in a live session','22023',pg_temp.create_sql(pg_temp.draft(d1,lines,jsonb_build_array(pg_temp.fact('f-symptom','symptom','Chest pain','synthetic'),pg_temp.fact('f-allergy','allergy','Penicillins')),'fic-pt-1','live'),'key-1'));
 perform pg_temp.refused('no lines','22023',pg_temp.create_sql(pg_temp.draft(d1,'[]'),'key-1'));
 perform pg_temp.refused('a line that was already approved','22023',pg_temp.create_sql(pg_temp.draft(d1,jsonb_build_array(pg_temp.line(l1,'lab-cbc','lab','requested','[]','[]','{"status":"approved"}'))),'key-1'));
 perform pg_temp.refused('a line with a decider','22023',pg_temp.create_sql(pg_temp.draft(d1,jsonb_build_array(pg_temp.line(l1,'lab-cbc','lab','requested','[]','[]','{"decidedBy":"55555555-5555-4555-8555-555555555555"}'))),'key-1'));
 perform pg_temp.refused('a line with an acknowledgement','22023',pg_temp.create_sql(pg_temp.draft(d1,jsonb_build_array(pg_temp.line(l1,'lab-cbc','lab','requested','[]','[]','{"acknowledged":["allergy"]}'))),'key-1'));
 perform pg_temp.refused('a proposed order without a cited fact','22023',pg_temp.create_sql(pg_temp.draft(d1,jsonb_build_array(pg_temp.line(l1,'lab-cbc','lab','proposed'))),'key-1'));
 perform pg_temp.refused('a citation the draft does not hold','22023',pg_temp.create_sql(pg_temp.draft(d1,jsonb_build_array(pg_temp.line(l1,'lab-cbc','lab','proposed','["f-elsewhere"]'))),'key-1'));
 perform pg_temp.refused('a flag citing a fact the draft does not hold','22023',pg_temp.create_sql(pg_temp.draft(d1,jsonb_build_array(pg_temp.line(l1,'lab-cbc','lab','requested','[]','[{"kind":"allergy","text":"x","evidenceIds":["f-elsewhere"]}]'))),'key-1'));
 perform pg_temp.refused('an unknown kind','22023',pg_temp.create_sql(pg_temp.draft(d1,jsonb_build_array(pg_temp.line(l1,'lab-cbc','pharmacy','requested'))),'key-1'));
 perform pg_temp.refused('a line id that is not an id','22023',pg_temp.create_sql(pg_temp.draft(d1,jsonb_build_array(pg_temp.line('not-an-id','lab-cbc','lab','requested'))),'key-1'));
 perform pg_temp.refused('a draft id that is not an id','22023',pg_temp.create_sql(pg_temp.draft('nope',lines),'key-1'));
 perform pg_temp.refused('no key','22023',format('select public.create_ehr_order_draft(%L::jsonb,%L::jsonb,null)',pg_temp.draft(d1,lines)::text,'{"patientId":"fic-pt-1","encounterId":"fic-enc-1","request":"prepare a CBC"}'));
 select count(*) into n from public.order_drafts; perform pg_temp.expect('a refused draft stores nothing', n = 0);

 -- Drafting stores the draft, its lines (all pending) and one audit event.
 select * into v_row from public.create_ehr_order_draft(pg_temp.draft(d1,lines),'{"patientId":"fic-pt-1","encounterId":"fic-enc-1","request":"prepare a CBC"}','key-1');
 perform pg_temp.expect('the draft is returned', v_row.id = d1::uuid and v_row.version = 1 and v_row.mode = 'case_based' and v_row.data_classification = 'live');
 select count(*) into n from public.order_lines where draft_id = d1::uuid and status = 'pending' and decided_by is null; perform pg_temp.expect('two pending lines', n = 2);
 select count(*) into n from public.order_lines where content ? 'status' or content ? 'id' or content ? 'catalogItemId'; perform pg_temp.expect('columns are not repeated in the content', n = 0);
 select count(*) into n from public.order_events where event_type = 'created' and draft_id = d1::uuid; perform pg_temp.expect('one created event', n = 1);
 select count(*) into n from public.order_events where detail::text like '%CBC%' or detail::text like '%prepare%' or detail::text like '%Fictional lab%' or detail::text like '%reason%'; perform pg_temp.expect('the audit trail holds no order or request text', n = 0);

 -- The same key and request is a replay; the same key for another request is refused; the draft id is not reusable.
 select * into v_row from public.create_ehr_order_draft(pg_temp.draft('bbbbbbbb-0000-4000-8000-00000000000b',jsonb_build_array(pg_temp.line('cccccccc-0000-4000-8000-00000000000c','lab-other','lab','requested'))),
   '{"patientId":"fic-pt-1","encounterId":"fic-enc-1","request":"prepare a CBC"}','key-1');
 perform pg_temp.expect('a replay returns the first draft', v_row.id = d1::uuid);
 select count(*) into n from public.order_drafts; perform pg_temp.expect('a replay stores nothing', n = 1);
 select count(*) into n from public.order_events; perform pg_temp.expect('a replay adds no event', n = 1);
 perform pg_temp.refused('the key for another request','P0001',pg_temp.create_sql(pg_temp.draft('dddddddd-0000-4000-8000-00000000000d',jsonb_build_array(pg_temp.line('eeeeeeee-0000-4000-8000-00000000000e','lab-x','lab','requested')),null,'fic-pt-1','live','a different request'),'key-1','a different request'));
 perform pg_temp.refused('the draft id again under a new key','23505',pg_temp.create_sql(pg_temp.draft(d1,lines),'key-2'));

 -- Only the drafting clinician reads it, only on this chart and classification, only with the permission.
 perform pg_temp.session(nurse);
 select count(*) into n from public.order_drafts; perform pg_temp.expect('another clinician sees no draft', n = 0);
 select count(*) into n from public.order_lines; perform pg_temp.expect('another clinician sees no line', n = 0);
 select count(*) into n from public.order_events; perform pg_temp.expect('another clinician sees no event', n = 0);
 select count(*) into n from public.order_idempotency; perform pg_temp.expect('another clinician sees no key', n = 0);
 perform pg_temp.session(physician || '{"patientId":"fic-pt-2"}');
 select count(*) into n from public.order_drafts; perform pg_temp.expect('another chart sees no draft', n = 0);
 perform pg_temp.session(physician || '{"dataClassification":"synthetic"}');
 select count(*) into n from public.order_drafts; perform pg_temp.expect('another classification sees no draft', n = 0);
 perform pg_temp.session(physician - 'scopes' || '{"scopes":["chart:read"]}');
 select count(*) into n from public.order_drafts; perform pg_temp.expect('no permission sees no draft', n = 0);
 perform pg_temp.session(physician);
 select count(*) into n from public.order_drafts; perform pg_temp.expect('the drafting physician sees the draft', n = 1);
 select count(*) into n from public.order_events; perform pg_temp.expect('and its audit trail', n = 1);
 select count(*) into n from public.order_idempotency; perform pg_temp.expect('and its key', n = 1);

 -- The duplicate check reads the whole visit as catalog ids and statuses, whoever drafted.
 perform pg_temp.session(nurse);
 select count(*) into n from public.encounter_order_items() where catalog_item_id in ('lab-cbc','med-amox') and status = 'pending';
 perform pg_temp.expect('a colleague sees which orders the visit already holds', n = 2);
 perform pg_temp.session(nurse || '{"patientId":"fic-pt-2"}');
 select count(*) into n from public.encounter_order_items(); perform pg_temp.expect('another visit shares nothing', n = 0);
 perform pg_temp.session(physician);

 -- The application writes nothing directly: not a draft, not a line, not an event, not a decision.
 perform pg_temp.refused('insert a draft','42501','insert into public.order_drafts(id,tenant_id,clinician_id,patient_id,encounter_id,data_classification,mode,request,catalog_version,clinical_facts,missing_information,provenance) values (gen_random_uuid(),''t'',gen_random_uuid(),''p'',''e'',''live'',''specific'',''x'',''v'',''[]'',''[]'',''{}'')');
 perform pg_temp.refused('insert a line','42501','insert into public.order_lines(id,draft_id,tenant_id,clinician_id,patient_id,encounter_id,data_classification,position,catalog_item_id,kind,content) select gen_random_uuid(),id,tenant_id,clinician_id,patient_id,encounter_id,data_classification,9,''x'',''lab'',''{}'' from public.order_drafts');
 perform pg_temp.refused('approve a line directly','42501',format('update public.order_lines set status=''approved'', decided_by=clinician_id, decided_at=now() where id=%L',l1));
 perform pg_temp.refused('change a line','42501',format('update public.order_lines set content=''{}'' where id=%L',l1));
 perform pg_temp.refused('change the request','42501','update public.order_drafts set request=''something else''');
 perform pg_temp.refused('delete a draft','42501','delete from public.order_drafts');
 perform pg_temp.refused('delete a line','42501','delete from public.order_lines');
 perform pg_temp.refused('edit audit','42501','update public.order_events set detail=''{"x":1}''');
 perform pg_temp.refused('delete audit','42501','delete from public.order_events');
 perform pg_temp.refused('forge an audit event','42501',format('insert into public.order_events(draft_id,tenant_id,clinician_id,event_type) values (%L,''fictional-live-tenant'',''55555555-5555-4555-8555-555555555555'',''line_approved'')',d1));
 perform pg_temp.refused('forge a key','42501','insert into public.order_idempotency(tenant_id,clinician_id,patient_id,encounter_id,action,key,draft_id,fingerprint,version) select tenant_id,clinician_id,patient_id,encounter_id,''create'',''key-9'',id,''{}'',1 from public.order_drafts');
 select count(*) into n from public.order_lines where status = 'pending'; perform pg_temp.expect('nothing was decided', n = 2);
end $$;

-- Whoever asks, a drafted order does not change and a decision, once made, is final.
reset session authorization;
do $$
declare l1 text := 'aaaaaaaa-0000-4000-8000-000000000001'; n integer;
begin
 perform pg_temp.refused('the words of a line','42501',format('update public.order_lines set content=''{}'' where id=%L',l1));
 perform pg_temp.refused('the catalog id of a line','42501',format('update public.order_lines set catalog_item_id=''other'' where id=%L',l1));
 perform pg_temp.refused('the request of a draft','42501','update public.order_drafts set request=''something else''');
 perform pg_temp.refused('the cited facts of a draft','42501','update public.order_drafts set clinical_facts=''[]''');
 perform pg_temp.refused('a decision without a decider','23514',format('update public.order_lines set status=''approved'' where id=%L',l1));
 update public.order_lines set status='approved', decided_by=clinician_id, decided_at=now(), acknowledged='["allergy"]', override_reason='fictional' where id=l1::uuid;
 update public.order_drafts set version = version + 1, updated_at = clock_timestamp();
 perform pg_temp.refused('a second decision','42501',format('update public.order_lines set status=''rejected'', decided_by=clinician_id, decided_at=now() where id=%L',l1));
 perform pg_temp.refused('another reason after the decision','42501',format('update public.order_lines set override_reason=''changed'' where id=%L',l1));
 select count(*) into n from public.order_lines where status='approved' and override_reason='fictional'; perform pg_temp.expect('the first decision stands', n = 1);
end $$;
rollback;
