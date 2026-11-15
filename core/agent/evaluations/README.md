# Clinical evaluation cases

Fictional cases for checking what the assistant and the scribe write. **No real patient, clinician or recording.** Each case states its input, the expected properties and the prompt version it was written for.

| Set | File | Cases | Always-on test | Real-model test (opt-in) |
| --- | --- | --- | --- | --- |
| Consultations | `consultation/cases.json` | 12 charts in FHIR R4 shape with a physician request | `tests/backend/consultation-evaluations.test.ts`: each chart goes through the real FHIR connector and the drafting service with a stand-in model | Same file with `RUN_CONSULTATION_LIVE_EVAL=1` |
| Scribe | `scribe/dialogues.json` | 10 visits in Saudi Arabic with English clinical terms, each with a chart | `tests/backend/scribe.test.ts` covers the validation rules | `tests/backend/scribe-note-live.test.ts` with `RUN_SCRIBE_LIVE_EVAL=1`; `scripts/scribe-benchmark.mjs` for transcription |

## Properties the cases check

Consultations: mentions a documented allergy; reports "no allergy recorded" as unknown, never as none; restates a recorded "no known allergy" in its own words; never invents a dose; leaves out refuted, entered-in-error, stopped and out-of-window records; keeps a provisional diagnosis provisional; questions a request that does not fit the chart or contradicts it; states an infant's age in months; stays inside the fact limits on a long chart and says what was left out.

Scribe: surfaces a conflict with the chart (patient denies allergies while the chart records one; a medicine stopped or taken at another dose) and links it to the chart fact; proposes a new allergy or patient-reported medicine as new; keeps the clinician's uncertainty in the assessment; puts only the clinician's decisions in the plan; adds no medicine, dose, test or diagnosis that was not said; records an intolerance as an intolerance.

## Adding a case

Write the smallest chart or dialogue that shows one behaviour, with the expected properties, and run both tests. A case that needs a real model to fail or pass belongs in the opt-in test only. Latest real-model results are in `docs/ai/scribe-benchmark.md`.
