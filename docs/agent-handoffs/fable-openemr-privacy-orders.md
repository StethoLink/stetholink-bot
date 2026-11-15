# Brief: working OpenEMR launch, patient pseudonymization, embedded UI, order drafting, no synthetic runtime

You are working on StethoLink (`StethoLink/stetholink-bot`). Read `AGENTS.md`, `docs/architecture/ARCHITECTURE.md`, `docs/coordination/HANDOFF.md` and `docs/coordination/WORKBOARD.md` before anything else. They are binding. This brief adds tasks; it does not override them.

## Rule zero: one task per conversation, always hand off

The owner wants the smallest possible token use without lowering quality. So:

1. **Do exactly one task (T1 to T8 below) per conversation.** When it is done, verified, committed and pushed, stop. Do not start the next task in the same conversation.
2. **Before stopping, update `docs/coordination/HANDOFF.md`** (newest state only, short): what was done, the commit SHAs, how it was verified, what failed or is unverified, and the exact next task. Mark the task on the workboard per `AGENTS.md`.
3. **End your last message with a ready-to-paste prompt for the next conversation**, under 15 lines: "Read `docs/coordination/HANDOFF.md` and `docs/agent-handoffs/fable-openemr-privacy-orders.md`, then do T<n>." Add only facts the handoff does not already hold.
4. In a new conversation, read the handoff and this brief, then only the files the task touches. Do not re-read history, re-derive settled facts or re-run checks unrelated to the task.
5. If a task is too big for one conversation, split it into numbered sub-steps in the handoff, finish one sub-step cleanly, and hand off.

Do the tasks in order: T1, T2, T3, T4, T5, T6, T7, T8. T1 and T2 come first because every later task needs a launch that can be debugged.

## Background: what went wrong in the OpenEMR attempt

A local run plugged StethoLink into a real OpenEMR (Docker, MariaDB, the owner's own test chart) and **failed**. OAuth worked and the token eventually carried patient and encounter context, but the callback kept failing and the chart never rendered. What we learned:

- **One error hides every cause.** `platform/auth/smart-session.ts` (`finishSmartLaunch`, around line 146) turns every failure in `verify()` except `ChartUnavailableError` into the same `"SMART clinician or chart context could not be verified"`. Nonce or `azp`/`at_hash` binding, a missing encounter, an unmapped clinician (`SMART_CLINICIAN_MAP`), an empty FHIR Patient or Encounter read and a JWKS failure all looked identical, and nothing was logged. Every retry cost the clinician another sign-in and consent.
- **OpenEMR omits the encounter** when `launch/patient` is requested together with `launch` (it treats that as standalone context). Remove `launch/patient` from the EHR-launch scope.
- **OpenEMR only sends an encounter when one is open in the chart.** If the chart header says "Open Encounter: None", the token has no encounter. This is a clinician-fixable condition, not an auth failure.
- **OpenEMR FHIR ACL bug:** the installed OpenEMR passed the numeric user ID into a patient-access check that expects the user's UUID, so FHIR reads were rejected. It was patched locally with a one-line change and a Compose source override. That is not acceptable as a product dependency.
- **After that patch it still failed.** The cause was never found. Likely candidates: the `sub`/`fhirUser` pair in `SMART_CLINICIAN_MAP` does not match exactly what OpenEMR signs (OpenEMR usually sends an absolute `fhirUser` URL with a UUID), or the FHIR read still returns nothing.
- **Registration:** OpenEMR rejected an unsupported scope and token-auth metadata in dynamic registration. A registered client stays **Disabled** until an admin clicks **Enable Client**.
- **TLS:** `next dev --experimental-https` replaced Node's CA setting, so the server could not verify OpenEMR's discovery until the OpenEMR certificate was passed explicitly. The embedded dialog also failed until the app's certificate was accepted in a top-level tab.
- **Leftovers on the owner's machine** (not in this repo): temporary callback diagnostics and the OpenEMR source override. Do not copy them into the repo.

## T1. Make launch failures diagnosable

- In `platform/auth/smart-session.ts`, give every failure branch of `verify()` a stable reason code (for example `binding_failed`, `id_token_invalid`, `missing_patient`, `missing_encounter`, `clinician_unmapped`, `clinician_reference_invalid`, `fhir_patient_unreadable`, `fhir_encounter_unreadable`, `jwks_unavailable`). Log the code server-side with a request correlation ID. Never log tokens, codes, the nonce, `sub`, `fhirUser` values, patient data or OAuth parameters (`AGENTS.md`).
- Keep the generic message for security failures. **A missing encounter becomes a clinician-facing message:** "Open a visit in the patient's chart, then launch StethoLink again." Use the existing `ChartUnavailableError` path or an equivalent.
- Show the correlation ID on the error page so an admin can match it to the log.
- Remove `launch/patient` from the EHR-launch scope, and document why.
- Tests for every reason code, plus a test that no secret or identifier reaches the log.

## T2. Get the real OpenEMR launch working end to end

- Add an admin preflight script (for example `scripts/smart-preflight.mts`). It checks discovery, pinned endpoints, PKCE S256, JWKS reachability, the CA trust StethoLink uses for server-to-server calls, that `SMART_CLINICIAN_MAP` entries are well-formed, and that the `fhirUser` form matches the issuer root. Each check prints a clear pass or fail. Run it before asking a human to sign in again.
- Make the clinician mapping accept both relative `Practitioner/<id>` and absolute `<issuer>/Practitioner/<id>`, and the UUID ids OpenEMR issues, without loosening the identity check.
- Find out whether the OpenEMR UUID ACL bug is in released OpenEMR. If it is, document the affected versions and the required fix in `docs/openemr.md`, and prepare an upstream issue text for the owner. Do not ship or require a patched OpenEMR.
- Rewrite `docs/openemr.md` as a precise runbook: registration fields OpenEMR accepts, **Enable Client**, scopes, the "Open Encounter must not be None" step, TLS for both the browser and the server, and the preflight script.
- Done means a launch from the OpenEMR chart renders the chart inside OpenEMR. If this environment cannot reach an OpenEMR, write the exact steps for the owner and say plainly that the launch is unverified.

## T3. Remove synthetic and mock behaviour from the product

The owner wants nothing in the running product to depend on fake data: no synthetic patients, no mock model, no mock specialist transport, no demo fallback.

- Remove the runtime paths that serve fabricated data or fabricated success: `CLINICAL_DATA_SOURCE=synthetic`, `AI_PROVIDER=mock` (`platform/tenants/model-provider.ts`), `integrations/mock/*` wiring in `integrations/index.ts` and `platform/providers/index.ts`, `shared/api-client/mock-client.ts` and `shared/mocks/synthetic-data.ts` where the app imports them, and the staging launch that runs on synthetic data. Without a real EHR, model or transport configured, the app must **fail closed with a clear configuration error**. It must never quietly show fake content.
- **Hard limit you must keep:** `AGENTS.md` forbids real patient data in the repository and in automated tests, and that is a legal and privacy requirement. Tests keep fictional fixtures, moved under `tests/` and never imported by app code. Add a build or lint check that fails if `apps/`, `core/`, `platform/` or `integrations/` import a fixture. "Real" means real systems: real OpenEMR or FHIR, a real model and real routing. It does not mean real people's records in git.
- Update the docs, the env schema and the workboard *Interface changes* section for every removed env value.

## T4. Pseudonymize patient data before it reaches the model provider

Nothing that identifies the patient may leave for OpenAI. Clinical meaning must stay intact.

- Add a de-identification layer at the single boundary where model requests are built (the `ModelProvider` returned by `getModelProvider()`), so no call path can bypass it. Keep the core logic in `core/` behind a port, per the architecture.
- **Replace direct identifiers with consistent surrogates for the session.** For example, the patient "Mohammed" becomes "Hassan" everywhere in that request and conversation, with the surrogate matching the original's sex and naming culture. Cover the patient, relatives, staff and other people named in free text, plus MRN, national ID, phone, email, address, insurance numbers, record and encounter IDs, and URLs.
- **Keep what is clinically meaningful unchanged:** age (cap at 90+ only where required by law), sex, vitals, labs and units, diagnoses, medications and doses, allergies, timelines. Convert dates to relative offsets from the encounter ("day -3", "3 years ago"), or shift them consistently, so intervals stay true.
- **Detect identifiers reliably.** First replace the exact strings we already know from the FHIR Patient, RelatedPerson and Practitioner resources (names, spelling variants, Arabic and Latin scripts, IDs, phones). Then run a pattern pass for ID, phone and date formats, and a name-detection pass for unknown names in free text. When in doubt, mask.
- **Map the model output back to real values on the server** before the physician sees it. The surrogate map lives only in server memory or encrypted session storage, expires with the session, and is never logged or sent anywhere.
- **Audio cannot be pseudonymized.** Scribe audio sent to OpenAI or ElevenLabs transcription contains the patient's voice and spoken name. Run the transcript through the same layer before any model step, and document plainly in `docs/go-live.md` that audio transcription needs a data processing agreement or an in-hospital transcription option. Do not claim the scribe is de-identified end to end.
- Tests: a leak test that fails if any known identifier (including Arabic spellings) appears in an outbound model payload, round-trip tests that the physician sees real names, and tests that age and clinical values are unchanged.

## T5. Make the embedded UI live inside the hospital system

- The app must run **inside** the EHR: in OpenEMR's embedded SMART frame or tab, with no popup, no new window and no redirect to an outside site. Fix whatever blocks this: frame headers (`frame-ancestors` limited to the tenant's EHR origin), cookies in a frame, and the certificate warning that forced a top-level tab. Prefer serving StethoLink same-site with the EHR, behind the hospital's reverse proxy, and document the setup.
- "Inside the system" also means no patient data goes anywhere except the tenant's EHR, StethoLink's own database and the pseudonymized model call from T4. Check for and remove any third-party fonts, analytics or CDNs at runtime.
- Improve the design of the embedded panel. It must fit a narrow EHR frame (360 px and up) and look native next to the host EHR, with clear hierarchy, readable clinical density, Arabic and English with correct RTL, and accessible contrast and focus. Follow `docs/ui/README.md` and the existing design system. Replace screenshots in `docs/ui/after/` with ones taken inside the real OpenEMR frame where possible.
- Clear states for loading, a missing open encounter (from T1), a resource the EHR did not grant, and errors with a correlation ID.

## T6. Draft orders, not only consultations

The physician should be able to say "prepare a CBC and a chest X-ray" or "prepare the basic orders for this case", and get drafted orders.

- Specific request: draft exactly the requested orders. Case-based request: propose the orders relevant to the case, **chosen only from the tenant's approved order catalog and order sets** (lab, imaging, medication, nursing). The model may pick and justify; it must not invent codes, products or doses outside the catalog.
- Each draft order cites the chart facts that justify it (the same grounding as consultations in `core/consultation/grounding.ts`), and flags allergies, duplicates of active orders, and medication interactions found in the chart.
- **Orders are drafts until a mapped physician approves each one** through the physician approval path (`AGENTS.md`). Nothing is signed or sent automatically. Write approved orders back as FHIR `ServiceRequest` and `MedicationRequest` where the EHR supports writes. Check what OpenEMR's FHIR API actually accepts. Where it does not support writes, show the approved order list for the clinician to enter, and say so in the UI.
- Requests and outputs go through the T4 pseudonymization layer.
- Tests: catalog-only selection, grounding citations, allergy flag, no write without approval, and a role test that a non-physician cannot approve.

## T7. Verify the whole flow on real systems

Run the full path against a real OpenEMR with a test patient created inside that EHR (an EHR test account, never a real person's record): launch inside the chart, chart render, scribe, consultation draft, order draft, physician approval, write-back. Record what passed, what failed and what could not be run, with the reason. Update `docs/coordination/HANDOFF.md` with the verified state.

## T8. Final report to the owner

A short plain-language report in Arabic: what works now, what was verified on a real system, what is still unverified, and what the hospital must provide (OpenEMR version or fix, TLS and reverse proxy, the clinician map, the order catalog, data processing agreements).

## Quality bar for every task

- Run the checks `AGENTS.md` lists before every push. Never weaken a test to get green.
- Report honestly: say "unverified" when something was not run against a real system. Never present simulated success as real.
- Keep the scope to the task. Note unrelated problems in the handoff instead of fixing them.
