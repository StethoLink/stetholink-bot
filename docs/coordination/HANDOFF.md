# Session handoff

Written at the end of each working session so the next one starts from this file instead of re-reading the whole history. Update it, commit it and push it before handing off. Newest state only; the detail is in [WORKBOARD.md](WORKBOARD.md).

## Where things stand (2026-11-15, after T1 of the OpenEMR brief)

- **Brief in progress:** [fable-openemr-privacy-orders.md](../agent-handoffs/fable-openemr-privacy-orders.md), tasks T1 to T9, one per conversation (its "Rule zero"). On the workboard they are `O-T1` to `O-T9`.
- **Branch:** all work of this brief is on `claude/wizardly-ptolemy-wyp0dh`, which is `main` (`6e0afdc`) plus the brief and T1. **It is not on `main`.** `AGENTS.md` says to push to `main`; the session that did T1 was started on this branch and pushed there only. Keep working on this branch; T9 merges it. If the owner says otherwise, fast-forward `main` to it (no conflicts: `main` has not moved).
- **The earlier brief** (live MVP, workboard T1 to T19) is complete and on `main`; its details are in the workboard log.

## T1 done: SMART launch failures are diagnosable

- **Commits:** `90d2a95` (claim), `88ae344` (code, tests, docs), and the commit that wrote this section.
- **What changed:** `platform/auth/smart-launch-failure.ts` (reason list, `SmartLaunchFailure`, the one log line, correlation ID), `platform/auth/smart-session.ts` (every branch throws a reason; mapping is checked before the visit; `ehrLaunchScope` drops `launch/patient`), `integrations/fhir/smart.ts` (`SmartExchangeError`), `integrations/fhir/connector.ts` (`FhirReadError`), `apps/embedded-app/server/http/launch-error.ts` (error page with the correlation ID; JSON for non-browser clients), both SMART routes, `docs/openemr.md` (section "When a launch fails": every reason and what to check), `.env.example`.
- **Behaviour:** a failed launch writes one line, `{"action":"smart.launch_failed","stage","reason","detail"?,"correlationId","at"}`. A token without an encounter answers 422 with "Open a visit in the patient's chart, then launch StethoLink again."; every security failure keeps the generic message. The page and the `X-Correlation-Id` header show the ID.
- **Verified:** `npm run check` (514 passed, 30 skipped opt-in), `npm run build`, `node --test tests/smoke/*.test.mts`. `tests/backend/smart-launch-diagnostics.test.ts` has a case for each of the 30 reasons (the suite fails if one has none) and checks in each that no console stream holds a token, code, state, nonce, verifier, subject, `fhirUser`, clinician or chart ID, client ID, host name or the EHR's error text.
- **Not verified:** nothing was run against OpenEMR or any real EHR. `tests/e2e/run-ci.sh` (Docker) was not re-run. The error page is plain English HTML; Arabic, RTL and the design system are T5.

## Next: T2 (real OpenEMR launch end to end)

Do the brief's T2 as written. What T1 leaves for it:

- The mapping still needs the signed `sub` and `fhirUser` to equal the map entry exactly (a relative entry does not match an absolute signed value, or the reverse). T2 makes both forms match. On a real attempt, the `clinician_unmapped` detail says which half failed and the form OpenEMR signed.
- The preflight script can reuse the checks behind `discovery_*`, `pkce_s256_unsupported`, `jwks_unavailable` and `registration_invalid` in `platform/auth/smart-session.ts` (`discover`, `registration`); they import `server-only`, so a script needs the logic moved to a plain module or repeated.
- This cloud environment has no OpenEMR. Check whether Docker can pull and run one before writing "unverified".

## What is left from the earlier brief

Not implemented, by decision or for lack of access (do not start them without the owner): EHR refresh token; a real email sender for specialist codes; registering `http-partner`; the Q6 "stated by the physician" source (design only, `docs/decisions/0003-physician-stated-source.md`); a transcription benchmark on human speech. The check against OpenEMR is now T2 and T7 of the current brief.

## Facts worth not re-deriving

- **Verified on a real server:** FHIR reads and conditional creates against HAPI FHIR JPA Server 8.12.0 in Docker (`tests/e2e/real-fhir-check.mts`); OpenAI and ElevenLabs transcription and the OpenAI note model on synthetic speech and fictional visits. **Verified with fake servers:** the whole SMART launch to chart-write to specialist round trip (`tests/e2e/live-ehr-flow.mts`). **Not verified:** any hospital EHR, a public SMART sandbox (hosts blocked by this environment's network policy: `launch.smarthealthit.org`, `r4.smarthealthit.org`, `hapi.fhir.org`), human speech, the microphone inside a real EHR iframe.
- **Benchmark:** `gpt-transcribe` chosen (word error rate 8.8%, medicines 87%, doses and readings 100%, allergies 100%, $0.0045 per minute); the cheaper `gpt-4o-mini-transcribe` failed the quality bar; ElevenLabs `scribe_v2` is the implemented alternative. **Measured cost of a 15-minute visit: about $0.074** (transcription $0.0675, note $0.0066), target was under $0.10.
- **A leak found and closed in Phase 4:** the older structured-draft path printed EHR record references into consultation text that could be sent to a specialist.
- **A fault found and fixed in Phase 5:** the production container failed at start because Next tried to install TypeScript to read `next.config.ts`; the config is now `next.config.mjs`.

## Working in the cloud container

- Docker: start the daemon with `nohup dockerd > /tmp/dockerd.log 2>&1 &`. If it refuses with a stale pid, remove `/var/run/docker.pid` and `/var/run/docker.sock` first. Docker Hub sometimes answers 429; wait and retry. Image builds need `--network host --build-arg HTTPS_PROXY=$HTTPS_PROXY`.
- Node's `fetch` needs `NODE_USE_ENV_PROXY=1` to reach outside hosts. `api.openai.com` and `api.elevenlabs.io` have proxy-injected credentials: pass `OPENAI_API_KEY=proxy-injected` (and `ELEVENLABS_API_KEY=proxy-injected`) to scripts that insist on a key.
- The proxy ends every outbound request at 30 seconds; long model calls fail here for that reason only.
- Playwright with Chromium is preinstalled: `NODE_PATH=/opt/node-tools/node_modules`.
- `consultation-flow.mjs` needs a fresh database for every run (it asserts an empty history). `live-ehr-flow.mts` run by hand needs a production build and a database with TLS, as `run-ci.sh` sets up (`localhost` URL plus `STETHOLINK_DATABASE_CA`); without TLS the launch answers 500. `scribe-flow.mjs` needs `SCRIBE_FAKE_AUDIO` with sound and pauses (a generated tone of 3 s on, 0.6 s off works).
- A synthetic staging app for browser work: PostgreSQL 17 in Docker on a loopback port, `STETHOLINK_TEST_OWNER_URL=... node tests/e2e/m3-migrations.mts` to apply migrations (fresh database each time; history is append-only), then `VERCEL_ENV=preview AUTH_MODE=staging STAGING_LAUNCH_SECRET=<32+ chars> STETHOLINK_DATABASE_URL=postgres://stetholink_runtime@127.0.0.1:<port>/postgres AI_PROVIDER=mock CLINICAL_DATA_SOURCE=synthetic SCRIBE_ENABLED=true npx next dev apps/embedded-app -p 3100`.

## Handing off

The owner asked that each step end with a fresh session, to keep context small without lowering quality: finish one step, run the checks that step needs, commit and push, update this file, then start a new session with a short prompt that points here.
