-- Synthetic fixtures inserted immediately before M3 to exercise an upgrade,
-- including tenantless historical data and an existing reviewed consultation.
insert into public.consultation_drafts(id,patient_id,status) values ('syn-m3-tenantless','syn-pt-001','pending_approval');
insert into public.consultation_drafts(id,tenant_id,clinician_id,patient_id,encounter_id,status,provider,model,prompt_version)
 values ('syn-m3-legacy','synthetic-test-a','11111111-1111-4111-8111-111111111111','syn-pt-001','syn-enc-001','pending_approval','mock','mock-1','legacy');
insert into public.consultation_drafts(id,tenant_id,clinician_id,patient_id,encounter_id,status,reviewed_by,reviewed_at,provider,model,prompt_version)
 values ('syn-m3-approved','synthetic-test-a','11111111-1111-4111-8111-111111111111','syn-pt-001','syn-enc-001','approved',
 '11111111-1111-4111-8111-111111111111',now(),'mock','mock-1','legacy');
