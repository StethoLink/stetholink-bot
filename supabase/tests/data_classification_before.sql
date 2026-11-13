-- Fictional fixtures written with the pre-classification commands, immediately before the
-- data classification migration, exactly as the previous application version wrote them:
-- `syntheticOnly: true` on the draft, the envelope and the callback, and a session context
-- without `dataClassification`. Committed, so the migration is exercised as an upgrade.
begin;
create function pg_temp.envelope(p_id text,p_base jsonb) returns jsonb language sql as $$
 select p_base || jsonb_build_object('approval',jsonb_build_object('approvedBy',reviewed_by::text,
  'approvedAt',to_char(date_trunc('milliseconds',reviewed_at) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
 from public.consultation_drafts where id=p_id;
$$;
set session authorization stetholink_runtime;
select set_config('stetholink.context',jsonb_build_object(
 'clinicianId','44444444-4444-4444-8444-444444444444','tenantId','synthetic-legacy-test',
 'patientId','syn-pt-legacy','encounterId','syn-enc-legacy','roles','["physician"]'::jsonb,
 'scopes','["chart:read","consultation:draft","consultation:approve","consultation:route"]'::jsonb,'authorization','active',
 'expiresAt',(extract(epoch from now())*1000)::bigint+600000)::text,true);
select set_config('stetholink.recipients','["team-a","team-b"]',true);
do $$
declare
 base jsonb := '{"patientId":"syn-pt-legacy","encounterId":"syn-enc-legacy","status":"pending_approval","summary":"Synthetic legacy summary","assessment":"Synthetic legacy assessment","plan":[],
   "clinicalFacts":[{"id":"syn-legacy-fact","category":"problem","label":"Fictional hypertension","status":"known","value":true,"source":{"type":"synthetic","reference":"synthetic-legacy-case"},"timestamp":"2026-01-01T00:00:00Z"}],
   "grounding":{"question":"Synthetic question","specialty":"Cardiology","reason":null,"gaps":[],"conflicts":[],"evidenceIds":[],"safetyFlags":["clinician_review_required"],
   "provenance":{"syntheticOnly":true,"provider":"mock","model":"mock-1","promptVersion":"legacy","contextVersion":"legacy","encounterReference":null}}}';
 env jsonb := '{"providerId":"team-a","tenantId":"synthetic-legacy-test","syntheticOnly":true,"summary":"Synthetic legacy summary","assessment":"Synthetic legacy assessment","plan":[]}';
 a public.consultation_delivery_attempts%rowtype;
 name text;
begin
 foreach name in array array['syn-legacy-pending','syn-legacy-approved','syn-legacy-sent','syn-legacy-other'] loop
  perform public.create_ehr_consultation(base||jsonb_build_object('id',name),'{"patientId":"syn-pt-legacy","encounterId":"syn-enc-legacy"}','legacy-create-'||name);
 end loop;
 perform public.review_ehr_consultation('syn-legacy-approved','approve','team-a',1,'legacy-approve-approved');
 perform public.review_ehr_consultation('syn-legacy-sent','approve','team-a',1,'legacy-approve-sent');
 perform public.dispatch_ehr_consultation('syn-legacy-sent',2,'legacy-send','team-a',pg_temp.envelope('syn-legacy-sent',env));
 select * into a from public.consultation_delivery_attempts where draft_id='syn-legacy-sent';
 perform public.record_ehr_dispatch_result(a.id,'sent','legacy-ref',null);
 perform public.record_provider_callback('synthetic-legacy-test',a.id,'team-a','legacy-accepted','accepted','{"syntheticOnly":true,"sentAt":"2026-01-01T00:00:00Z"}');
end $$;
reset session authorization;
drop function pg_temp.envelope(text,jsonb);
commit;
