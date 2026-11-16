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
create function pg_temp.fact(p_id text,p_category text,p_label text) returns jsonb language sql as $$
 select jsonb_build_object('id',p_id,'category',p_category,'label',p_label,'status','known','value','fictional',
  'source',jsonb_build_object('type','fhir','reference','R/'||p_id),'timestamp','2026-01-15T10:00:00.000Z') $$;
create function pg_temp.line(p_id text,p_item text,p_kind text,p_basis text,p_evidence jsonb default '[]',p_flags jsonb default '[]') returns jsonb language sql as $$
 select jsonb_build_object('id',p_id,'catalogItemId',p_item,'kind',p_kind,'display','Fictional '||p_item,'basis',p_basis,'reason','A fictional reason.',
  'evidenceIds',p_evidence,'flags',p_flags,'status','pending') $$;
create function pg_temp.draft(p_id text,p_lines jsonb,p_request text default 'prepare orders') returns jsonb language sql as $$
 select jsonb_build_object('id',p_id,'patientId','fic-pt-1','encounterId','fic-enc-1','mode','case_based','request',p_request,'catalogVersion','fictional-1',
  'lines',p_lines,'unmatched','[]'::jsonb,'notes','[]'::jsonb,
  'clinicalFacts',jsonb_build_array(pg_temp.fact('f-symptom','symptom','Chest pain'),pg_temp.fact('f-allergy','allergy','Penicillins'),pg_temp.fact('f-med','medication','Warfarin')),
  'missingInformation','[]'::jsonb,
  'provenance',jsonb_build_object('provider','fictional','model','fictional-model','promptVersion','order-authoring@1.0.0','dataClassification','live','rejectedLines',0),
  'version',1,'createdAt','2026-01-15T10:00:00.000Z','updatedAt','2026-01-15T10:00:00.000Z') $$;
create function pg_temp.decide_sql(p_draft text,p_version integer,p_key text,p_decisions jsonb) returns text language sql as $$
 select format('select public.decide_ehr_order_lines(%L::uuid,%s,%L,%L::jsonb)',p_draft,p_version,p_key,p_decisions::text) $$;
set session authorization stetholink_runtime;

do $$
declare
 physician jsonb := jsonb_build_object('clinicianId','55555555-5555-4555-8555-555555555555','tenantId','fictional-live-tenant','patientId','fic-pt-1','encounterId','fic-enc-1',
  'roles','["physician"]'::jsonb,'scopes','["chart:read","order:draft","order:approve","chart:write"]'::jsonb,'authorization','active','dataClassification','live');
 d1 text := '9f6b7c1e-1c1f-4c58-9a57-0d7f6f0d1a11';
 d2 text := '9f6b7c1e-1c1f-4c58-9a57-0d7f6f0d1a22';
 l1 text := 'aaaaaaaa-0000-4000-8000-000000000001'; -- laboratory, no flag
 l2 text := 'aaaaaaaa-0000-4000-8000-000000000002'; -- medication, documented allergy
 l3 text := 'aaaaaaaa-0000-4000-8000-000000000003'; -- medication, major interaction
 l4 text := 'aaaaaaaa-0000-4000-8000-000000000004'; -- medication, moderate interaction and a duplicate
 l5 text := 'aaaaaaaa-0000-4000-8000-000000000005'; -- imaging
 m1 text := 'bbbbbbbb-0000-4000-8000-000000000001';
 key1 text := 'sl-ord-aaaaaaaa000040008000000000000001';
 allergy jsonb := '[{"kind":"allergy","text":"A documented allergy.","evidenceIds":["f-allergy"]}]';
 major jsonb := '[{"kind":"interaction","severity":"major","text":"The hospital rule.","evidenceIds":["f-med"]}]';
 minor jsonb := '[{"kind":"interaction","severity":"moderate","text":"The hospital rule.","evidenceIds":["f-med"]},{"kind":"duplicate_active","text":"Already active.","evidenceIds":["f-med"]}]';
 reason text := 'The patient tolerated it before; benefit outweighs the risk.';
 n integer; v_row public.order_drafts%rowtype; v_ver integer;
begin
 perform pg_temp.session(physician);
 select * into v_row from public.create_ehr_order_draft(pg_temp.draft(d1,jsonb_build_array(
   pg_temp.line(l1,'lab-cbc','lab','requested'), pg_temp.line(l2,'med-amox','medication','proposed','["f-symptom"]',allergy),
   pg_temp.line(l3,'med-ibu','medication','requested','[]',major), pg_temp.line(l4,'med-warf','medication','requested','[]',minor),
   pg_temp.line(l5,'img-cxr','imaging','requested'))),'{"patientId":"fic-pt-1","encounterId":"fic-enc-1","request":"prepare orders"}','create-1');
 perform pg_temp.expect('drafted at version 1', v_row.version = 1);

 -- Nothing may reach the chart before approval, by anyone.
 perform pg_temp.refused('write a pending order','42501',format('select public.begin_chart_write(''order'',%L,%L,''ServiceRequest'')',l1,key1));

 -- Who may decide: the drafting physician with the permission, on the chart's verified session.
 perform pg_temp.session(physician || '{"roles":["clinician"]}');
 perform pg_temp.refused('a non-physician approves','42501',pg_temp.decide_sql(d1,1,'k-nurse',jsonb_build_array(jsonb_build_object('lineId',l1,'decision','approve'))));
 perform pg_temp.session(physician - 'scopes' || '{"scopes":["chart:read","order:draft"]}');
 perform pg_temp.refused('a physician without the approving permission','42501',pg_temp.decide_sql(d1,1,'k-noscope',jsonb_build_array(jsonb_build_object('lineId',l1,'decision','approve'))));
 perform pg_temp.session(physician - 'scopes' || '{"scopes":["chart:read","order:approve"]}');
 perform pg_temp.refused('no drafting permission','42501',pg_temp.decide_sql(d1,1,'k-nodraft',jsonb_build_array(jsonb_build_object('lineId',l1,'decision','approve'))));
 perform pg_temp.session(physician || '{"clinicianId":"66666666-6666-4666-8666-666666666666"}');
 perform pg_temp.refused('another clinician','P0002',pg_temp.decide_sql(d1,1,'k-other',jsonb_build_array(jsonb_build_object('lineId',l1,'decision','approve'))));
 perform pg_temp.session(physician || '{"patientId":"fic-pt-2"}');
 perform pg_temp.refused('another chart','P0002',pg_temp.decide_sql(d1,1,'k-chart',jsonb_build_array(jsonb_build_object('lineId',l1,'decision','approve'))));
 perform pg_temp.session(physician || '{"dataClassification":"synthetic"}');
 perform pg_temp.refused('another classification','P0002',pg_temp.decide_sql(d1,1,'k-class',jsonb_build_array(jsonb_build_object('lineId',l1,'decision','approve'))));
 perform set_config('stetholink.context',(physician || '{"expiresAt":1}')::text,true);
 perform pg_temp.refused('expired session','42501',pg_temp.decide_sql(d1,1,'k-expired',jsonb_build_array(jsonb_build_object('lineId',l1,'decision','approve'))));
 perform pg_temp.session(physician);
 select count(*) into n from public.order_lines where status <> 'pending'; perform pg_temp.expect('nothing was decided by a refused command', n = 0);

 -- The shape of a command.
 perform pg_temp.refused('no decisions','22023',pg_temp.decide_sql(d1,1,'k-1','[]'));
 perform pg_temp.refused('not a list','22023',pg_temp.decide_sql(d1,1,'k-1','{"lineId":"x"}'));
 perform pg_temp.refused('no key','22023',format('select public.decide_ehr_order_lines(%L::uuid,1,null,%L::jsonb)',d1,jsonb_build_array(jsonb_build_object('lineId',l1,'decision','approve'))::text));
 perform pg_temp.refused('an unknown decision','22023',pg_temp.decide_sql(d1,1,'k-1',jsonb_build_array(jsonb_build_object('lineId',l1,'decision','sign'))));
 perform pg_temp.refused('a line id that is not an id','22023',pg_temp.decide_sql(d1,1,'k-1',jsonb_build_array(jsonb_build_object('lineId','l1','decision','approve'))));
 perform pg_temp.refused('an extra field','22023',pg_temp.decide_sql(d1,1,'k-1',jsonb_build_array(jsonb_build_object('lineId',l1,'decision','approve','dose','5 g'))));
 perform pg_temp.refused('an unknown flag kind','22023',pg_temp.decide_sql(d1,1,'k-1',jsonb_build_array(jsonb_build_object('lineId',l1,'decision','approve','acknowledged',jsonb_build_array('nothing')))));
 perform pg_temp.refused('the same line twice','22023',pg_temp.decide_sql(d1,1,'k-1',jsonb_build_array(jsonb_build_object('lineId',l1,'decision','approve'),jsonb_build_object('lineId',l1,'decision','reject'))));
 perform pg_temp.refused('a stale version','P0001',pg_temp.decide_sql(d1,2,'k-1',jsonb_build_array(jsonb_build_object('lineId',l1,'decision','approve'))));
 perform pg_temp.refused('an order that is not in the draft','P0002',pg_temp.decide_sql(d1,1,'k-1',jsonb_build_array(jsonb_build_object('lineId','cccccccc-0000-4000-8000-00000000000c','decision','approve'))));
 perform pg_temp.refused('a draft that does not exist','P0002',pg_temp.decide_sql('dddddddd-0000-4000-8000-00000000000d',1,'k-1',jsonb_build_array(jsonb_build_object('lineId',l1,'decision','approve'))));

 -- An allergy or a major interaction needs the flag acknowledged and a reason; nothing else does.
 perform pg_temp.refused('allergy: nothing acknowledged','22023',pg_temp.decide_sql(d1,1,'k-2',jsonb_build_array(jsonb_build_object('lineId',l2,'decision','approve'))));
 perform pg_temp.refused('allergy: no reason','22023',pg_temp.decide_sql(d1,1,'k-2',jsonb_build_array(jsonb_build_object('lineId',l2,'decision','approve','acknowledged',jsonb_build_array('allergy')))));
 perform pg_temp.refused('allergy: a reason that says nothing','22023',pg_temp.decide_sql(d1,1,'k-2',jsonb_build_array(jsonb_build_object('lineId',l2,'decision','approve','acknowledged',jsonb_build_array('allergy'),'overrideReason','ok'))));
 perform pg_temp.refused('allergy: the wrong flag acknowledged','22023',pg_temp.decide_sql(d1,1,'k-2',jsonb_build_array(jsonb_build_object('lineId',l2,'decision','approve','acknowledged',jsonb_build_array('interaction'),'overrideReason',reason))));
 perform pg_temp.refused('major interaction: nothing acknowledged','22023',pg_temp.decide_sql(d1,1,'k-2',jsonb_build_array(jsonb_build_object('lineId',l3,'decision','approve','overrideReason',reason))));
 perform pg_temp.refused('a reason that is too long','22023',pg_temp.decide_sql(d1,1,'k-2',jsonb_build_array(jsonb_build_object('lineId',l2,'decision','approve','acknowledged',jsonb_build_array('allergy'),'overrideReason',repeat('x',501)))));
 -- A command is all or nothing: a valid line beside an invalid one is not decided.
 perform pg_temp.refused('one bad line spoils the command','22023',pg_temp.decide_sql(d1,1,'k-2',jsonb_build_array(jsonb_build_object('lineId',l1,'decision','approve'),jsonb_build_object('lineId',l2,'decision','approve'))));
 select count(*) into n from public.order_lines where status <> 'pending'; perform pg_temp.expect('all or nothing', n = 0);
 select count(*) into n from public.order_events where event_type <> 'created'; perform pg_temp.expect('no event without a decision', n = 0);

 -- The physician decides: an order without a flag, a moderate interaction and a duplicate (no override needed), a rejection with nothing more.
 select * into v_row from public.decide_ehr_order_lines(d1::uuid,1,'k-3',jsonb_build_array(
   jsonb_build_object('lineId',l1,'decision','approve'), jsonb_build_object('lineId',l4,'decision','approve'), jsonb_build_object('lineId',l5,'decision','reject')));
 perform pg_temp.expect('one new version for one command', v_row.version = 2);
 select count(*) into n from public.order_lines where draft_id = d1::uuid and status = 'approved' and decided_by = '55555555-5555-4555-8555-555555555555'::uuid and decided_at is not null and acknowledged is null and override_reason is null;
 perform pg_temp.expect('two approved by the physician without an override', n = 2);
 select count(*) into n from public.order_lines where id = l5::uuid and status = 'rejected' and decided_by is not null; perform pg_temp.expect('one rejected', n = 1);
 select count(*) into n from public.order_lines where status = 'pending'; perform pg_temp.expect('two still pending', n = 2);
 -- The allergy and the major interaction, with the acknowledgement and the reason, in a second command at the new version.
 select * into v_row from public.decide_ehr_order_lines(d1::uuid,2,'k-4',jsonb_build_array(
   jsonb_build_object('lineId',l2,'decision','approve','acknowledged',jsonb_build_array('allergy','allergy'),'overrideReason',reason),
   jsonb_build_object('lineId',l3,'decision','approve','acknowledged',jsonb_build_array('interaction','duplicate_active'),'overrideReason','  '||reason||'  ')));
 perform pg_temp.expect('the second command is version 3', v_row.version = 3);
 select count(*) into n from public.order_lines where id = l2::uuid and acknowledged = '["allergy"]'::jsonb and override_reason = reason; perform pg_temp.expect('the allergy is acknowledged once, with its reason', n = 1);
 select count(*) into n from public.order_lines where id = l3::uuid and acknowledged = '["duplicate_active","interaction"]'::jsonb and override_reason = reason; perform pg_temp.expect('the reason is stored trimmed', n = 1);
 select count(*) into n from public.order_events where event_type = 'line_approved' and (detail->>'overridden')::boolean; perform pg_temp.expect('two overrides are audited', n = 2);
 select count(*) into n from public.order_events where event_type in ('line_approved','line_rejected') and (detail::text like '%tolerated%' or detail::text like '%fictional-1%' or detail::text like '%Fictional%'); perform pg_temp.expect('the audit trail holds no reason or order text', n = 0);
 select count(*) into n from public.order_events where event_type in ('line_approved','line_rejected') and line_id is not null; perform pg_temp.expect('five decisions audited', n = 5);

 -- A decision is final, and a retry is not a second decision.
 perform pg_temp.refused('decide again','P0001',pg_temp.decide_sql(d1,3,'k-5',jsonb_build_array(jsonb_build_object('lineId',l1,'decision','reject'))));
 select * into v_row from public.decide_ehr_order_lines(d1::uuid,1,'k-3',jsonb_build_array(
   jsonb_build_object('lineId',l1,'decision','approve'), jsonb_build_object('lineId',l4,'decision','approve'), jsonb_build_object('lineId',l5,'decision','reject')));
 perform pg_temp.expect('a retry returns the draft as it is', v_row.id = d1::uuid and v_row.version = 3);
 select count(*) into n from public.order_events where event_type in ('line_approved','line_rejected'); perform pg_temp.expect('a retry adds no event', n = 5);
 perform pg_temp.refused('the key for another decision','P0001',pg_temp.decide_sql(d1,1,'k-3',jsonb_build_array(jsonb_build_object('lineId',l1,'decision','reject'))));
 perform pg_temp.refused('direct update of a decision','42501',format('update public.order_lines set status=''rejected'' where id=%L',l1));

 -- Write-back: only for a line this physician approved, under the key of that line, as the resource its kind needs.
 perform pg_temp.refused('a rejected order','42501',format('select public.begin_chart_write(''order'',%L,%L,''ServiceRequest'')',l5,'sl-ord-aaaaaaaa000040008000000000000005'));
 perform pg_temp.refused('a laboratory order as a medication request','42501',format('select public.begin_chart_write(''order'',%L,%L,''MedicationRequest'')',l1,key1));
 perform pg_temp.refused('a medication as a service request','42501',format('select public.begin_chart_write(''order'',%L,%L,''ServiceRequest'')',l2,'sl-ord-aaaaaaaa000040008000000000000002'));
 perform pg_temp.refused('another key','42501',format('select public.begin_chart_write(''order'',%L,%L,''ServiceRequest'')',l1,'sl-ord-aaaaaaaa000040008000000000000009'));
 perform pg_temp.refused('an order that does not exist','42501','select public.begin_chart_write(''order'',''cccccccc-0000-4000-8000-00000000000c'',''sl-ord-cccccccc000040008000000000000000c'',''ServiceRequest'')');
 perform pg_temp.session(physician || '{"roles":["clinician"]}');
 perform pg_temp.refused('a non-physician writes an approved order','42501',format('select public.begin_chart_write(''order'',%L,%L,''ServiceRequest'')',l1,key1));
 perform pg_temp.session(physician - 'scopes' || '{"scopes":["chart:read","order:draft","chart:write"]}');
 perform pg_temp.refused('no approving permission','42501',format('select public.begin_chart_write(''order'',%L,%L,''ServiceRequest'')',l1,key1));
 perform pg_temp.session(physician || '{"patientId":"fic-pt-2"}');
 perform pg_temp.refused('another chart','42501',format('select public.begin_chart_write(''order'',%L,%L,''ServiceRequest'')',l1,key1));
 perform pg_temp.session(physician);
 perform public.begin_chart_write('order',l1,key1,'ServiceRequest');
 perform public.begin_chart_write('order',l2,'sl-ord-aaaaaaaa000040008000000000000002','MedicationRequest');
 perform public.begin_chart_write('order',l1,key1,'ServiceRequest');
 select count(*) into n from public.chart_writes where origin_kind = 'order' and status = 'pending'; perform pg_temp.expect('two ledger rows, the repeat adds none', n = 2);
 perform public.record_chart_write(key1,'created','fic-sr-1',null);
 perform public.record_chart_write(key1,'failed',null,'late failure');
 select count(*) into n from public.chart_writes where item_key = key1 and status = 'created' and resource_id = 'fic-sr-1'; perform pg_temp.expect('a recorded success is final', n = 1);
 perform pg_temp.refused('other kinds of origin still need their own approval','42501','select public.begin_chart_write(''consultation'',''no-such-draft'',''sl-0123456789-consult'',''DocumentReference'')');

 -- A second draft, for the retention check below.
 perform public.create_ehr_order_draft(pg_temp.draft(d2,jsonb_build_array(pg_temp.line(m1,'lab-cbc','lab','requested')),'another set'),'{"patientId":"fic-pt-1","encounterId":"fic-enc-1","request":"another set"}','create-2');
 select count(*) into n from public.order_drafts; perform pg_temp.expect('two drafts', n = 2);
end $$;

-- Retention, as the maintenance login: order drafts follow the consultation period, with everything that belongs to them.
reset session authorization;
update public.order_drafts set updated_at = now() - interval '40 days' where id = '9f6b7c1e-1c1f-4c58-9a57-0d7f6f0d1a11';
do $$
declare r jsonb; n integer;
begin
 set session authorization stetholink_maintenance;
 r := public.run_retention(null,null,null);
 reset session authorization;
 select count(*) into n from public.order_drafts; perform pg_temp.expect('no period, nothing removed', n = 2);
 set session authorization stetholink_maintenance;
 r := public.run_retention(null,30,null);
 reset session authorization;
 perform pg_temp.expect('the old draft is counted', (r->>'orderDraftsDeleted')::int = 1);
 select count(*) into n from public.order_drafts; perform pg_temp.expect('the recent draft is kept', n = 1);
 select count(*) into n from public.order_lines where draft_id = '9f6b7c1e-1c1f-4c58-9a57-0d7f6f0d1a11'; perform pg_temp.expect('its lines went with it', n = 0);
 select count(*) into n from public.order_events where draft_id = '9f6b7c1e-1c1f-4c58-9a57-0d7f6f0d1a11'; perform pg_temp.expect('its audit trail went with it', n = 0);
 select count(*) into n from public.order_idempotency where draft_id = '9f6b7c1e-1c1f-4c58-9a57-0d7f6f0d1a11'; perform pg_temp.expect('its keys went with it', n = 0);
 select count(*) into n from public.chart_writes where origin_kind = 'order'; perform pg_temp.expect('its ledger rows went with it', n = 0);
 select count(*) into n from public.order_events where draft_id = '9f6b7c1e-1c1f-4c58-9a57-0d7f6f0d1a22'; perform pg_temp.expect('the recent draft keeps its audit trail', n = 1);
end $$;
rollback;
