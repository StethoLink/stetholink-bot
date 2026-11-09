-- SYNTHETIC DATA ONLY. Never seed real patient information.
insert into public.consultation_drafts (id, patient_id, encounter_id, status, summary, assessment, plan)
values ('syn-draft-001', 'syn-pt-001', 'syn-enc-001', 'pending_approval',
        'Synthetic follow-up summary.', 'Synthetic assessment.', '["Synthetic plan item 1"]')
on conflict (id) do nothing;
