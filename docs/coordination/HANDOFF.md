# Session handoff

Written at the end of each working session so the next one starts from this file instead of re-reading the whole history. Update it, commit it and push it before handing off. Newest state only; the detail is in [WORKBOARD.md](WORKBOARD.md).

## Where things stand (2026-11-15, after T2 of the OpenEMR brief)

- **Brief in progress:** [fable-openemr-privacy-orders.md](../agent-handoffs/fable-openemr-privacy-orders.md), tasks T1 to T9, one per conversation (its "Rule zero"). On the workboard they are `O-T1` to `O-T9`. **T1 and T2 are done. Next is T3.**
- **Branch:** all work of this brief is on `claude/wizardly-ptolemy-wyp0dh`, which is `main` (`6e0afdc`) plus the brief, T1 and T2. **It is not on `main`.** `AGENTS.md` says to push to `main`; these sessions were started on this branch and push there only. Keep working on this branch; T9 merges it.
- **The earlier brief** (live MVP, workboard T1 to T19) is complete and on `main`; its details are in the workboard log.
- **T1** (commit `88ae344`): every SMART launch failure has a reason code, logged once with the correlation ID the error page shows. Reasons and what to check: `docs/openemr.md`, "When a launch fails".

## T2 done: the launch works on a real OpenEMR 7.0.3

- **Commits:** `a244499` (claim), `5b2f539` (code and tests), and the commit that wrote this section (runbook, issue text, board).
- **What changed:** `integrations/fhir/smart.ts` (plain module: `clinicianReference`, `sameFhirUser`, `parseClinicianMap`, `checkSmartDiscovery`, `ehrLaunchScope`), `integrations/fhir/smart-preflight.ts` and `scripts/smart-preflight.mts` (`npm run smart:preflight`), `platform/auth/smart-session.ts` (uses them; a map entry matches the signed `fhirUser` relative or absolute on `FHIR_BASE_URL`; new reason `clinician_not_practitioner`), `docs/openemr.md` (runbook), `docs/openemr-upstream-issue.md` (text for the owner to file; **not filed**).
- **Verified on real systems (Docker, fictional patient created inside OpenEMR, Chromium driving OpenEMR's own pages, production build behind a local HTTPS proxy):**
  - OpenEMR **7.0.3 unpatched**: launch from the patient dashboard, OpenEMR sign-in and consent, callback, and StethoLink showing the patient and visit **inside the OpenEMR window**. Also with OpenEMR's authorization-flow skip on.
  - OpenEMR **8.5.0 unpatched**: the launch reaches the callback and fails with `fhir_patient_unreadable` (`http:401`). This is the "UUID ACL bug": present in the 8.4.0, 8.4.1, 8.5.0 and 8.6.0 releases and on `master`; absent in 7.0.3 (run) and 7.0.4 to 8.3.0 (source read only).
  - The preflight against both, including its failure without OpenEMR's certificate in `NODE_EXTRA_CA_CERTS`.
- **Why the owner's attempt failed, as far as this run shows:** OpenEMR signs `Person/<uuid>` for a user without an NPI, so no `Practitioner/...` map entry could match; and on 8.4.0 or later the FHIR reads fail in OpenEMR whatever StethoLink does. Which OpenEMR version the owner ran is not known here.
- **Not verified:** a browser that checks certificates (the test browser accepted the local test certificates); StethoLink and OpenEMR on different sites (both were `localhost`, so cookies were same-site); the admin menu paths by clicking (pages were opened by address); a hospital's own OpenEMR and single sign-on; anything after the first screen. The patient was created with OpenEMR's patient service from the command line and the NPI was set in the database, not through OpenEMR's screens. `tests/e2e/run-ci.sh` was not re-run.
- **Checks:** `npm run check` (553 passed, 30 skipped opt-in), `npm run build`, `node --test tests/smoke/*.test.mts`.

## Next: T3 (remove synthetic and mock behaviour from the product)

Do the brief's T3 as written. Notes from T2:

- `registration()` in `platform/auth/smart-session.ts` still tests `CLINICAL_DATA_SOURCE === "synthetic"`; the preflight (`integrations/fhir/smart-preflight.ts`) only requires `AUTH_MODE=smart`.
- OpenEMR's FHIR API reports a visit as `finished` while it is open in the chart; the header then reads "Outpatient visit, finished". Left as is (T5 or T7 may want other wording).
- For T5: in the frame, cookies worked only because both were on `localhost`. For T7: use OpenEMR 7.0.3 unless OpenEMR has fixed 8.x.

## Running a real OpenEMR here (about 10 minutes)

- `docker network create oe`; `docker run -d --name oe-db --network oe -e MYSQL_ROOT_PASSWORD=root mariadb:11.4`; wait until it accepts connections (otherwise OpenEMR's setup stops with "unable to connect to database as root"); then `docker run -d --name oe --network oe -p 127.0.0.1:9300:443 -e MYSQL_HOST=oe-db -e MYSQL_ROOT_PASS=root -e MYSQL_USER=openemr -e MYSQL_PASS=openemr -e OE_USER=admin -e OE_PASS=<password> -e OPENEMR_SETTING_rest_api=1 -e OPENEMR_SETTING_rest_fhir_api=1 -e OPENEMR_SETTING_site_addr_oath=https://localhost:9300 openemr/openemr:7.0.3`. Ready when `https://localhost:9300/apis/default/fhir/metadata` answers 200.
- Its certificate: `docker exec oe cat /etc/ssl/certs/webserver.cert.pem`; put it, with the app's test certificate, in the file `NODE_EXTRA_CA_CERTS` names.
- The app: production build, database with TLS as in `tests/e2e/run-ci.sh`, `startTlsProxy` from `tests/e2e/fakes/tls.mts` in front (3082 to 3081), live-mode env as in `tests/e2e/live-ehr-flow.mts` with the OpenEMR values from `docs/openemr.md`.
- In the browser (Playwright, `ignoreHTTPSErrors`): log in at `/interface/login/login.php?site=default`, choose "Ask again later" on the product registration dialog (do not submit it), enable the client at `/interface/smart/admin-client.php`, open the chart with `navigateTab(webroot_url + '/interface/patient_file/summary/demographics.php?set_pid=1', 'pat', ...)`, open a visit at `/interface/forms/newpatient/new.php?autoloaded=1&calenc=` (or `encounter_top.php?set_encounter=<id>` for an existing one), then press `.smart-launch-btn` in the dashboard frame. PHP run by hand inside the 8.x container must run as `apache`, not root.

## What is left from the earlier brief

Not implemented, by decision or for lack of access (do not start them without the owner): EHR refresh token; a real email sender for specialist codes; registering `http-partner`; the Q6 "stated by the physician" source (design only, `docs/decisions/0003-physician-stated-source.md`); a transcription benchmark on human speech. The first OpenEMR check is done (T2); the whole flow is T7.

## Facts worth not re-deriving

- **Verified on a real server:** FHIR reads and conditional creates against HAPI FHIR JPA Server 8.12.0 in Docker (`tests/e2e/real-fhir-check.mts`); OpenAI and ElevenLabs transcription and the OpenAI note model on synthetic speech and fictional visits. **Verified with fake servers:** the whole SMART launch to chart-write to specialist round trip (`tests/e2e/live-ehr-flow.mts`). **Verified on a real OpenEMR 7.0.3 (T2):** the SMART launch from the chart up to the first screen. **Not verified:** any hospital EHR, a public SMART sandbox (hosts blocked by this environment's network policy: `launch.smarthealthit.org`, `r4.smarthealthit.org`, `hapi.fhir.org`), human speech, the microphone inside a real EHR iframe.
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
