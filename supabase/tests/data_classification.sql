-- Owner connection to disposable PostgreSQL; all test changes roll back.
-- Fictional data only: no identifier or clinical statement here describes a real person.
begin;
create function pg_temp.envelope(p_id text,p_base jsonb) returns jsonb language sql as $$
 select p_base || jsonb_build_object('approval',jsonb_build_object('approvedBy',reviewed_by::text,
  'approvedAt',to_char(date_trunc('milliseconds',reviewed_at) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
 from public.consultation_drafts where id=p_id;
$$;
-- Runs one statement and requires it to fail with exactly the given SQLSTATE.
-- 42501 insufficient_privilege, 22023 invalid_parameter_value, P0001 conflict, P0002 not found.
create function pg_temp.refused(p_label text,p_state text,p_sql text) returns void language plpgsql as $$
declare outcome text := 'accepted';
begin
 begin execute p_sql; exception when others then outcome := sqlstate; end;
 if outcome <> p_state then raise exception 'Expected % for "%", got %',p_state,p_label,outcome; end if;
end $$;
create function pg_temp.session(p_context jsonb) returns void language sql as $$
 select set_config('stetholink.context',(p_context||jsonb_build_object('expiresAt',(extract(epoch from now())*1000)::bigint+600000))::text,true);
$$;
set session authorization stetholink_runtime;
select set_config('stetholink.recipients','["team-a","team-b"]',true);

do $$
declare
 scopes jsonb := '["chart:read","consultation:draft","consultation:approve","consultation:route"]';
 -- The synthetic tenant that owns the pre-migration rows.
 syn jsonb := jsonb_build_object('clinicianId','44444444-4444-4444-8444-444444444444','tenantId','synthetic-legacy-test',
  'patientId','syn-pt-legacy','encounterId','syn-enc-legacy','roles','["physician"]'::jsonb,'scopes',scopes,
  'authorization','active','dataClassification','synthetic');
 -- A live tenant: verified SMART physician on a fictional chart.
 live jsonb := jsonb_build_object('clinicianId','55555555-5555-4555-8555-555555555555','tenantId','fictional-live-tenant',
  'patientId','fic-pt-live-001','encounterId','fic-enc-live-001','roles','["physician"]'::jsonb,'scopes',scopes,
  'authorization','active','dataClassification','live');
 syn_request text := '{"patientId":"syn-pt-legacy","encounterId":"syn-enc-legacy"}';
 live_request text := '{"patientId":"fic-pt-live-001","encounterId":"fic-enc-live-001"}';
 syn_fact jsonb := '[{"id":"syn-fact","category":"problem","label":"Fictional hypertension","status":"known","value":true,"source":{"type":"synthetic","reference":"synthetic-case"},"timestamp":"2026-01-01T00:00:00Z"}]';
 live_fact jsonb := '[{"id":"Condition-fic-1","category":"problem","label":"Fictional hypertension","status":"known","value":true,"source":{"type":"fhir","reference":"Condition/fic-1"},"timestamp":"2026-01-01T00:00:00Z"}]';
 provenance jsonb := '{"provider":"fake-model","model":"fake-1","promptVersion":"test","contextVersion":"test","encounterReference":null}';
 grounding jsonb := '{"question":"Fictional question","specialty":"Cardiology","reason":null,"gaps":[],"conflicts":[],"evidenceIds":[],"safetyFlags":["clinician_review_required"]}';
 content jsonb := '{"status":"pending_approval","summary":"Fictional summary","assessment":"Fictional assessment","plan":[]}';
 syn_draft jsonb; live_draft jsonb;
 syn_env jsonb := '{"providerId":"team-a","tenantId":"synthetic-legacy-test","dataClassification":"synthetic","summary":"Synthetic legacy summary","assessment":"Synthetic legacy assessment","plan":[]}';
 live_env jsonb := '{"providerId":"team-a","tenantId":"fictional-live-tenant","dataClassification":"live","summary":"Fictional summary","assessment":"Fictional assessment","plan":[]}';
 d public.consultation_drafts%rowtype;
 a public.consultation_delivery_attempts%rowtype;
 r jsonb; n integer; name text; change jsonb;
begin
 syn_draft := content||'{"patientId":"syn-pt-legacy","encounterId":"syn-enc-legacy"}'||jsonb_build_object('clinicalFacts',syn_fact,
  'grounding',grounding||jsonb_build_object('provenance',provenance||'{"dataClassification":"synthetic"}'));
 live_draft := content||'{"patientId":"fic-pt-live-001","encounterId":"fic-enc-live-001"}'||jsonb_build_object('clinicalFacts',live_fact,
  'grounding',grounding||jsonb_build_object('provenance',provenance||'{"dataClassification":"live"}'));

 ---------------------------------------------------------------------------------------------
 -- 1. Rows written before the migration stay readable and count as synthetic.
 ---------------------------------------------------------------------------------------------
 perform pg_temp.session(syn);
 select count(*) into n from public.consultation_drafts
  where clinical_metadata->'grounding'->'provenance'->>'syntheticOnly'='true' and not clinical_metadata->'grounding'->'provenance' ? 'dataClassification';
 if n<>4 then raise exception 'Legacy rows were rewritten or are unreadable (%)',n; end if;
 if (select count(*) from public.consultation_revisions where draft_id like 'syn-legacy-%')<4
   or (select count(*) from public.consultation_provider_responses where draft_id='syn-legacy-sent')<>1
  then raise exception 'Legacy history is unreadable'; end if;

 -- A session without a server-derived classification can read its chart but run no command.
 perform pg_temp.session(syn-'dataClassification');
 if (select count(*) from public.consultation_drafts)<>4 then raise exception 'Unclassified session lost read access to its chart'; end if;
 perform pg_temp.refused('unclassified create','42501',format('select public.create_ehr_consultation(%L,%L,null)',syn_draft||'{"id":"syn-x"}',syn_request));
 perform pg_temp.refused('unclassified approval','42501','select public.review_ehr_consultation(''syn-legacy-pending'',''approve'',''team-a'',1,''k-unclassified'')');
 foreach change in array array['{"dataClassification":"production"}'::jsonb,'{"dataClassification":true}'::jsonb,'{"dataClassification":null}'::jsonb,'{"syntheticOnly":true}'::jsonb] loop
  perform pg_temp.session((syn-'dataClassification')||change);
  perform pg_temp.refused('invalid session classification','42501','select public.review_ehr_consultation(''syn-legacy-pending'',''approve'',''team-a'',1,''k-invalid'')');
 end loop;

 -- The same physician path works on legacy rows: approve, dispatch, transport result, callbacks.
 perform pg_temp.session(syn);
 select * into d from public.review_ehr_consultation('syn-legacy-pending','approve','team-a',1,'approve-legacy-pending');
 if d.status<>'approved' or d.approved_recipient_id<>'team-a' then raise exception 'Legacy draft not approved'; end if;
 -- New writes use the new field: the retired flag is refused on an envelope.
 perform pg_temp.refused('legacy flag on a new envelope','22023',format('select public.dispatch_ehr_consultation(''syn-legacy-pending'',2,''k-old-flag'',''team-a'',%L)',
  pg_temp.envelope('syn-legacy-pending',(syn_env-'dataClassification')||'{"syntheticOnly":true}')));
 perform pg_temp.refused('envelope carrying both fields','22023',format('select public.dispatch_ehr_consultation(''syn-legacy-pending'',2,''k-both'',''team-a'',%L)',
  pg_temp.envelope('syn-legacy-pending',syn_env||'{"syntheticOnly":true}')));
 perform pg_temp.refused('unclassified envelope','22023',format('select public.dispatch_ehr_consultation(''syn-legacy-pending'',2,''k-none'',''team-a'',%L)',
  pg_temp.envelope('syn-legacy-pending',syn_env-'dataClassification')));
 select * into d from public.dispatch_ehr_consultation('syn-legacy-pending',2,'send-legacy-pending','team-a',pg_temp.envelope('syn-legacy-pending',syn_env));
 if d.status<>'queued' then raise exception 'Legacy draft not dispatched'; end if;
 select * into a from public.consultation_delivery_attempts where draft_id='syn-legacy-pending';
 perform public.record_ehr_dispatch_result(a.id,'sent','ref-legacy-pending',null);
 perform set_config('stetholink.data_classification','synthetic',true);
 r := public.record_provider_callback('synthetic-legacy-test',a.id,'team-a','acc-1','accepted','{"dataClassification":"synthetic"}');
 if r->>'disposition'<>'applied' or r->>'status'<>'accepted' then raise exception 'Callback for an upgraded legacy draft not applied'; end if;
 -- Approved before the migration, dispatched after it.
 select * into d from public.dispatch_ehr_consultation('syn-legacy-approved',2,'send-legacy-approved','team-a',pg_temp.envelope('syn-legacy-approved',syn_env));
 if d.status<>'queued' then raise exception 'Approval recorded before the migration no longer dispatches'; end if;
 -- In flight across the migration: the stored legacy request and callback still correlate.
 select * into a from public.consultation_delivery_attempts where draft_id='syn-legacy-sent';
 if a.envelope->>'syntheticOnly'<>'true' or a.envelope ? 'dataClassification' then raise exception 'Legacy envelope was rewritten'; end if;
 r := public.record_provider_callback('synthetic-legacy-test',a.id,'team-a','legacy-accepted','accepted','{"dataClassification":"synthetic","sentAt":"2026-01-02T00:00:00Z"}');
 if r->>'disposition'<>'duplicate' then raise exception 'Retransmitted legacy callback not recognised as a duplicate'; end if;
 perform pg_temp.refused('legacy response id reused with other content','P0001',format(
  'select public.record_provider_callback(''synthetic-legacy-test'',%L,''team-a'',''legacy-accepted'',''accepted'',''{"dataClassification":"synthetic","reason":"changed"}'')',a.id));
 perform pg_temp.refused('retired flag on an inbound callback','22023',format(
  'select public.record_provider_callback(''synthetic-legacy-test'',%L,''team-a'',''rep-old'',''report'',''{"syntheticOnly":true,"report":{"summary":"Synthetic report"}}'')',a.id));
 r := public.record_provider_callback('synthetic-legacy-test',a.id,'team-a','rep-1','report','{"dataClassification":"synthetic","report":{"summary":"Synthetic report"}}');
 if r->>'disposition'<>'applied' or r->>'status'<>'responded' then raise exception 'Report for a legacy request not applied'; end if;
 -- Revision, submission and cancellation of a legacy draft are unchanged.
 select * into d from public.review_ehr_consultation('syn-legacy-other','request_changes',null,1,'reopen-legacy');
 select * into d from public.change_ehr_consultation('syn-legacy-other','revise',2,'revise-legacy','{"summary":"Synthetic revised","assessment":"Synthetic","plan":[]}');
 select * into d from public.change_ehr_consultation('syn-legacy-other','submit',3,'submit-legacy','{}');
 if d.status<>'pending_review' or d.version<>4 then raise exception 'Legacy draft lifecycle changed'; end if;
 -- An idempotent replay of a pre-migration command still returns its original snapshot.
 select * into d from public.review_ehr_consultation('syn-legacy-approved','approve','team-a',1,'legacy-approve-approved');
 if d.version<>2 or d.status<>'approved' then raise exception 'Legacy idempotent replay changed'; end if;

 ---------------------------------------------------------------------------------------------
 -- 2. A synthetic session writes synthetic records only (synthetic-to-live mixing is refused).
 ---------------------------------------------------------------------------------------------
 perform public.create_ehr_consultation(syn_draft||'{"id":"syn-new"}',syn_request::jsonb,'create-syn-new');
 if (select clinical_metadata->'grounding'->'provenance'->>'dataClassification' from public.consultation_drafts where id='syn-new')<>'synthetic'
  then raise exception 'Synthetic draft not stored with its classification'; end if;
 foreach change in array array[
   jsonb_build_object('grounding',grounding||jsonb_build_object('provenance',provenance||'{"dataClassification":"live"}')),
   jsonb_build_object('grounding',grounding||jsonb_build_object('provenance',provenance)),
   jsonb_build_object('grounding',grounding||jsonb_build_object('provenance',provenance||'{"syntheticOnly":true}')),
   jsonb_build_object('grounding',grounding||jsonb_build_object('provenance',provenance||'{"syntheticOnly":true,"dataClassification":"synthetic"}')),
   jsonb_build_object('grounding',grounding||jsonb_build_object('provenance',provenance||'{"dataClassification":"production"}')),
   jsonb_build_object('clinicalFacts',live_fact),
   jsonb_build_object('clinicalFacts',syn_fact||live_fact),
   jsonb_build_object('missingInformation',live_fact),
   jsonb_build_object('attachments','[{"id":"att-1","contentType":"application/pdf","source":{"type":"openemr","reference":"DocumentReference/fic-1"},"timestamp":"2026-01-01T00:00:00Z"}]'::jsonb),
   jsonb_build_object('clinicalFacts','{"not":"an array"}'::jsonb)] loop
  perform pg_temp.refused('synthetic session storing '||change::text,'22023',format('select public.create_ehr_consultation(%L,%L,null)',syn_draft||change||'{"id":"syn-mixed"}',syn_request));
 end loop;
 if exists(select 1 from public.consultation_drafts where id='syn-mixed') then raise exception 'Refused draft was stored'; end if;
 -- A synthetic session cannot send its consultation in a live envelope.
 perform public.review_ehr_consultation('syn-new','approve','team-a',1,'approve-syn-new');
 perform pg_temp.refused('synthetic consultation in a live envelope','22023',format('select public.dispatch_ehr_consultation(''syn-new'',2,''k-live-env'',''team-a'',%L)',
  pg_temp.envelope('syn-new',syn_env||'{"dataClassification":"live","summary":"Fictional summary","assessment":"Fictional assessment"}')));

 ---------------------------------------------------------------------------------------------
 -- 3. A live session cannot touch synthetic or legacy records (the same chart ids, as after a
 --    tenant is switched to live), and cannot write synthetic content.
 ---------------------------------------------------------------------------------------------
 perform pg_temp.session(syn||'{"dataClassification":"live"}');
 if (select count(*) from public.consultation_drafts)<5 then raise exception 'Existing rows are no longer readable'; end if;
 perform pg_temp.refused('live approval of a legacy draft','42501','select public.review_ehr_consultation(''syn-legacy-other'',''approve'',''team-a'',4,''k-live-1'')');
 perform pg_temp.refused('live approval of a synthetic draft','42501','select public.review_ehr_consultation(''syn-new'',''reject'',null,2,''k-live-2'')');
 perform pg_temp.refused('live cancel of a synthetic draft','42501','select public.change_ehr_consultation(''syn-new'',''cancel'',2,''k-live-3'',''{}'')');
 perform pg_temp.refused('live dispatch of a synthetic draft','42501',format('select public.dispatch_ehr_consultation(''syn-new'',2,''k-live-4'',''team-a'',%L)',
  pg_temp.envelope('syn-new',syn_env||'{"dataClassification":"live","summary":"Fictional summary","assessment":"Fictional assessment"}')));
 perform pg_temp.refused('live dispatch with a synthetic envelope','22023',format('select public.dispatch_ehr_consultation(''syn-new'',2,''k-live-5'',''team-a'',%L)',
  pg_temp.envelope('syn-new',syn_env||'{"summary":"Fictional summary","assessment":"Fictional assessment"}')));
 perform pg_temp.refused('live transport result for a synthetic request','42501',format('select public.record_ehr_dispatch_result(%L,''sent'',''x'',null)',
  (select id from public.consultation_delivery_attempts where draft_id='syn-legacy-approved')));
 -- An idempotency key recorded by the synthetic session never replays into a live session.
 perform pg_temp.refused('cross-classification idempotent replay','42501',format('select public.create_ehr_consultation(%L,%L,''create-syn-new'')',syn_draft||'{"id":"syn-new"}',syn_request));
 perform pg_temp.refused('cross-classification legacy replay','42501','select public.review_ehr_consultation(''syn-legacy-approved'',''approve'',''team-a'',1,''legacy-approve-approved'')');
 if (select status from public.consultation_drafts where id='syn-new')<>'approved' then raise exception 'Refused live command changed a synthetic draft'; end if;

 perform pg_temp.session(live);
 foreach change in array array[
   jsonb_build_object('grounding',grounding||jsonb_build_object('provenance',provenance||'{"dataClassification":"synthetic"}')),
   jsonb_build_object('grounding',grounding||jsonb_build_object('provenance',provenance||'{"syntheticOnly":true}')),
   jsonb_build_object('grounding',grounding||jsonb_build_object('provenance',provenance)),
   jsonb_build_object('clinicalFacts',syn_fact),
   jsonb_build_object('clinicalFacts',live_fact||syn_fact)] loop
  perform pg_temp.refused('live session storing '||change::text,'22023',format('select public.create_ehr_consultation(%L,%L,null)',live_draft||change||'{"id":"fic-mixed"}',live_request));
 end loop;

 ---------------------------------------------------------------------------------------------
 -- 4. A live draft is approved and dispatched through the same physician path, with every
 --    existing boundary intact.
 ---------------------------------------------------------------------------------------------
 select * into d from public.create_ehr_consultation(live_draft||'{"id":"fic-live-1"}',live_request::jsonb,'create-live-1');
 if d.status<>'pending_review' or d.version<>1 or d.tenant_id<>'fictional-live-tenant'
   or d.clinical_metadata->'grounding'->'provenance'->>'dataClassification'<>'live'
   or d.clinical_metadata->'clinicalFacts'->0->'source'->>'reference'<>'Condition/fic-1' then raise exception 'Live draft not stored with its classification and source reference'; end if;
 perform public.create_ehr_consultation(live_draft||'{"id":"fic-live-2"}',live_request::jsonb,'create-live-2');
 -- Physician-only approval, with its own scope.
 perform pg_temp.session(live||'{"roles":["clinician"]}');
 perform pg_temp.refused('live approval by a non-physician','42501','select public.review_ehr_consultation(''fic-live-1'',''approve'',''team-a'',1,''k-nonphysician'')');
 perform pg_temp.session(live||'{"scopes":["chart:read","consultation:draft","consultation:route"]}');
 perform pg_temp.refused('live approval without the review scope','42501','select public.review_ehr_consultation(''fic-live-1'',''approve'',''team-a'',1,''k-noscope'')');
 perform pg_temp.session(live);
 -- Tenant allowlist.
 perform pg_temp.refused('live approval for a provider off the allowlist','42501','select public.review_ehr_consultation(''fic-live-1'',''approve'',''team-z'',1,''k-allowlist'')');
 -- Not before approval.
 perform pg_temp.refused('live dispatch before approval','P0001',format('select public.dispatch_ehr_consultation(''fic-live-1'',1,''k-early'',''team-a'',%L)',live_env||'{"approval":{}}'));
 -- Stale version.
 perform pg_temp.refused('live approval of a stale version','P0001','select public.review_ehr_consultation(''fic-live-1'',''approve'',''team-a'',7,''k-stale'')');
 select * into d from public.review_ehr_consultation('fic-live-1','approve','team-a',1,'approve-live-1');
 if d.status<>'approved' or d.version<>2 or d.reviewed_by<>'55555555-5555-4555-8555-555555555555' or d.approved_recipient_id<>'team-a'
  then raise exception 'Live draft not approved by the physician'; end if;
 if (select count(*) from public.consultation_events where draft_id='fic-live-1')<2 then raise exception 'Live approval left no event'; end if;

 -- Routing is a separate scope and is bound to the approved destination, content and tenant.
 perform pg_temp.session(live||'{"scopes":["chart:read","consultation:draft","consultation:approve"]}');
 perform pg_temp.refused('live dispatch without the route scope','42501',format('select public.dispatch_ehr_consultation(''fic-live-1'',2,''k-noroute'',''team-a'',%L)',pg_temp.envelope('fic-live-1',live_env)));
 perform pg_temp.session(live||'{"roles":["clinician"]}');
 perform pg_temp.refused('live dispatch by a non-physician','42501',format('select public.dispatch_ehr_consultation(''fic-live-1'',2,''k-nonphys'',''team-a'',%L)',pg_temp.envelope('fic-live-1',live_env)));
 perform pg_temp.session(live);
 perform pg_temp.refused('live dispatch to a destination that was not approved','42501',format('select public.dispatch_ehr_consultation(''fic-live-1'',2,''k-dest'',''team-b'',%L)',
  pg_temp.envelope('fic-live-1',live_env||'{"providerId":"team-b"}')));
 foreach change in array array['{"dataClassification":"synthetic"}'::jsonb,'{"syntheticOnly":true}'::jsonb,'{"tenantId":"synthetic-legacy-test"}'::jsonb,
   '{"summary":"Altered after approval"}'::jsonb,'{"plan":["Added after approval"]}'::jsonb,'{"requestId":"00000000-0000-4000-8000-000000000000"}'::jsonb] loop
  perform pg_temp.refused('live envelope with '||change::text,'22023',format('select public.dispatch_ehr_consultation(''fic-live-1'',2,''k-env'',''team-a'',%L)',
   pg_temp.envelope('fic-live-1',live_env||change)));
 end loop;
 perform pg_temp.refused('live envelope without the stored approval','22023',format('select public.dispatch_ehr_consultation(''fic-live-1'',2,''k-unattributed'',''team-a'',%L)',live_env));
 if exists(select 1 from public.consultation_delivery_attempts where draft_id='fic-live-1') then raise exception 'Refused live dispatch left a request'; end if;

 select * into d from public.dispatch_ehr_consultation('fic-live-1',2,'send-live-1','team-a',pg_temp.envelope('fic-live-1',live_env));
 if d.status<>'queued' or d.version<>3 then raise exception 'Live draft not queued'; end if;
 select * into d from public.dispatch_ehr_consultation('fic-live-1',2,'send-live-1','team-a',pg_temp.envelope('fic-live-1',live_env));
 select count(*) into n from public.consultation_delivery_attempts where draft_id='fic-live-1';
 if n<>1 or d.version<>3 then raise exception 'Live replay created a second request'; end if;
 select * into a from public.consultation_delivery_attempts where draft_id='fic-live-1';
 if a.envelope->>'dataClassification'<>'live' or a.envelope ? 'syntheticOnly' or a.envelope->>'requestId'<>a.id::text or a.approval_version<>2
  then raise exception 'Live envelope not bound to its request, approval and classification'; end if;
 select * into d from public.record_ehr_dispatch_result(a.id,'sent','ref-live-1',null);
 if d.status<>'sent' then raise exception 'Live transport result not recorded'; end if;

 -- Callbacks: the tenant, the request and the callback must all be live.
 perform pg_temp.refused('synthetic callback for a live request','22023',format(
  'select public.record_provider_callback(''fictional-live-tenant'',%L,''team-a'',''acc-x'',''accepted'',''{"dataClassification":"synthetic"}'')',a.id));
 perform pg_temp.refused('live callback under a synthetic tenant setting','22023',format(
  'select public.record_provider_callback(''fictional-live-tenant'',%L,''team-a'',''acc-x'',''accepted'',''{"dataClassification":"live"}'')',a.id));
 perform set_config('stetholink.data_classification','',true);
 perform pg_temp.refused('callback without a tenant classification','22023',format(
  'select public.record_provider_callback(''fictional-live-tenant'',%L,''team-a'',''acc-x'',''accepted'',''{"dataClassification":"live"}'')',a.id));
 perform set_config('stetholink.data_classification','live',true);
 foreach change in array array['{}'::jsonb,'{"syntheticOnly":true}'::jsonb,'{"dataClassification":"production"}'::jsonb,'{"dataClassification":"live","syntheticOnly":true}'::jsonb] loop
  perform pg_temp.refused('callback classified '||change::text,'22023',format(
   'select public.record_provider_callback(''fictional-live-tenant'',%L,''team-a'',''acc-x'',''accepted'',%L)',a.id,change));
 end loop;
 perform pg_temp.refused('live callback from another provider','P0002',format(
  'select public.record_provider_callback(''fictional-live-tenant'',%L,''team-b'',''acc-x'',''accepted'',''{"dataClassification":"live"}'')',a.id));
 perform pg_temp.refused('live callback for another tenant','P0002',format(
  'select public.record_provider_callback(''synthetic-legacy-test'',%L,''team-a'',''acc-x'',''accepted'',''{"dataClassification":"live"}'')',a.id));
 -- A live tenant cannot answer a synthetic request either.
 perform pg_temp.refused('live callback for a synthetic request','22023',format(
  'select public.record_provider_callback(''synthetic-legacy-test'',%L,''team-a'',''acc-x'',''accepted'',''{"dataClassification":"live"}'')',
  (select id from public.consultation_delivery_attempts where draft_id='syn-legacy-approved')));
 if exists(select 1 from public.consultation_provider_responses where response_id='acc-x') then raise exception 'Refused callback was stored'; end if;
 r := public.record_provider_callback('fictional-live-tenant',a.id,'team-a','acc-live','accepted','{"dataClassification":"live"}');
 if r->>'disposition'<>'applied' or r->>'status'<>'accepted' then raise exception 'Live acceptance not applied'; end if;
 r := public.record_provider_callback('fictional-live-tenant',a.id,'team-a','rep-live','report','{"dataClassification":"live","sentAt":"2026-01-01T00:00:00Z","report":{"summary":"Fictional report"}}');
 if r->>'disposition'<>'applied' or r->>'status'<>'responded' then raise exception 'Live report not applied'; end if;
 r := public.record_provider_callback('fictional-live-tenant',a.id,'team-a','rep-live','report','{"dataClassification":"live","sentAt":"2026-01-02T00:00:00Z","report":{"summary":"Fictional report"}}');
 if r->>'disposition'<>'duplicate' then raise exception 'Live duplicate not recognised'; end if;
 select * into d from public.consultation_drafts where id='fic-live-1';
 if d.status<>'responded' or (select count(*) from public.consultation_provider_responses where draft_id='fic-live-1')<>2
  then raise exception 'Live response not readable by the physician'; end if;

 -- The allowlist is checked again when a queued live request is sent.
 perform public.review_ehr_consultation('fic-live-2','approve','team-a',1,'approve-live-2');
 perform public.dispatch_ehr_consultation('fic-live-2',2,'send-live-2','team-a',pg_temp.envelope('fic-live-2',live_env));
 perform set_config('stetholink.recipients','["team-b"]',true);
 perform pg_temp.refused('live send after the provider left the allowlist','42501',format('select public.record_ehr_dispatch_result(%L,''sent'',''x'',null)',
  (select id from public.consultation_delivery_attempts where draft_id='fic-live-2')));
 perform set_config('stetholink.recipients','["team-a","team-b"]',true);

 -- Live-to-synthetic mixing: a synthetic session on the same chart ids cannot act on live records.
 perform pg_temp.session(live||'{"dataClassification":"synthetic"}');
 if (select count(*) from public.consultation_drafts)<>2 then raise exception 'Chart rows are no longer readable'; end if;
 perform pg_temp.refused('synthetic cancel of a live draft','42501','select public.change_ehr_consultation(''fic-live-2'',''cancel'',3,''k-syn-1'',''{}'')');
 perform pg_temp.refused('synthetic transport result for a live request','42501',format('select public.record_ehr_dispatch_result(%L,''failed'',null,''transport_error'')',
  (select id from public.consultation_delivery_attempts where draft_id='fic-live-2')));
 perform pg_temp.refused('synthetic replay of a live command','42501','select public.review_ehr_consultation(''fic-live-2'',''approve'',''team-a'',1,''approve-live-2'')');
 perform pg_temp.refused('synthetic draft on a live chart with live facts','22023',format('select public.create_ehr_consultation(%L,%L,null)',
  live_draft||jsonb_build_object('id','fic-mixed','grounding',grounding||jsonb_build_object('provenance',provenance||'{"dataClassification":"synthetic"}')),live_request));
 if (select status from public.consultation_drafts where id='fic-live-2')<>'queued' or exists(select 1 from public.consultation_drafts where id='fic-mixed')
  then raise exception 'Refused synthetic command changed live records'; end if;
 -- Rejection stays a physician decision in live mode too.
 perform pg_temp.session(live);
 perform public.create_ehr_consultation(live_draft||'{"id":"fic-live-3"}',live_request::jsonb,null);
 select * into d from public.review_ehr_consultation('fic-live-3','reject',null,1,'reject-live-3');
 if d.status<>'rejected' then raise exception 'Live rejection not recorded'; end if;
end $$;
reset session authorization;
do $$
declare f text;
begin
 -- The classification helpers and the command engine are reachable only through the public commands.
 foreach f in array array['stetholink_private.record_classification(jsonb)','stetholink_private.context_classification(jsonb)',
   'stetholink_private.draft_classification(jsonb)','stetholink_private.facts_match_classification(jsonb,text)',
   'stetholink_private.with_classification(jsonb)','stetholink_private.consultation_command(text,text,integer,text,jsonb)'] loop
  if has_function_privilege('stetholink_runtime',f,'execute') or has_function_privilege('anon',f,'execute') or has_function_privilege('authenticated',f,'execute')
   then raise exception 'Role can call % directly',f; end if;
 end loop;
 if has_function_privilege('anon','public.record_provider_callback(text,uuid,text,text,text,jsonb)','execute')
   or has_function_privilege('authenticated','public.dispatch_ehr_consultation(text,integer,text,text,jsonb)','execute')
   or has_function_privilege('stetholink_runtime','public.dispatch_ehr_consultation(text,text,integer,text)','execute')
   or not has_function_privilege('stetholink_runtime','public.dispatch_ehr_consultation(text,integer,text,text,jsonb)','execute')
   or not has_function_privilege('stetholink_runtime','public.record_provider_callback(text,uuid,text,text,text,jsonb)','execute')
  then raise exception 'Routing command privileges changed'; end if;
 -- The callback command still refuses any caller that is not the runtime service role.
 begin
  perform public.record_provider_callback('fictional-live-tenant',gen_random_uuid(),'team-a','x','accepted','{"dataClassification":"live"}');
  raise exception using errcode='XX000',message='Non-runtime caller accepted';
 exception when insufficient_privilege then null; end;
 -- Legacy rows are still stored exactly as they were written.
 if (select count(*) from public.consultation_drafts where id like 'syn-legacy-%'
   and clinical_metadata->'grounding'->'provenance'->>'syntheticOnly'='true')<>4 then raise exception 'Legacy rows were rewritten'; end if;
end $$;
rollback;
