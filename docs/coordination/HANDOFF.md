# Session handoff

Written at the end of each working session so the next one starts from this file instead of re-reading the whole history. Update it, commit it and push it before handing off. Newest state only; the detail is in [WORKBOARD.md](WORKBOARD.md).

## Where things stand (2026-11-15)

- **Branch:** all work is on `claude/new-session-xgixce` (the session may not push to `main`). `main` is still at `7b0ffc9`. The branch is pushed; nothing is uncommitted.
- **Brief:** "live MVP as an EHR plugin" (scribe, EHR write-back, specialist inbox, redesign, operations), five phases. **Phases 0 to 5 are implemented and every workboard task (T5 to T19) is `done`.** Read the newest five *Log* entries on the workboard for what each phase did, how it was verified and which decisions were taken.
- **Checks at the last commit, all passing:** `npm run check` (461 passed, 30 skipped opt-in), `npm run build`, `node --test tests/smoke/*.test.mts`, `bash tests/e2e/run-ci.sh` (Docker, PostgreSQL 17). The production image builds and runs healthy.

## What is left

1. **Final report to the owner, in Arabic, plain language** (the brief asks for seven points: what was finished per phase with commit links; how each thing was verified, real server or fake servers or not verified; benchmark results, chosen provider and measured cost per visit; before and after screenshots; what remains and who must do it; what the owner must do outside the code; environment variables for the first pilot). Everything it needs is in the workboard log, `docs/ai/scribe-benchmark.md`, `docs/sandbox.md`, `docs/go-live.md` (sections 1, 4, 10) and `docs/ui/README.md`. Commit links: `https://github.com/StethoLink/stetholink-bot/commit/<sha>`.
2. Small follow-ups, only if time allows, each a separate small commit:
   - `tests/e2e/README.md` does not yet describe `live-ehr-flow.mts` (and its `LIVE_E2E_BROWSER=1` step), `real-fhir-check.mts`, `browser/scribe-flow.mjs`, `supabase/tests/scribe.sql` and `operations.sql`.
   - `docs/ui/` has consultation screenshots only; scribe and inbox screenshots can be added from `tests/e2e/browser/scribe-flow.mjs` and the `LIVE_E2E_BROWSER=1` step (`BROWSER_SCREENSHOT_DIR`).
   - Re-run the two Chromium walkthroughs after Phase 5 (they last passed before it): `tests/e2e/browser/consultation-flow.mjs` and `scribe-flow.mjs`.
3. **Not implemented, by decision or for lack of access** (say so in the report; do not start them without the owner): EHR refresh token; a real email sender for specialist codes; registering `http-partner`; the Q6 "stated by the physician" source (design only, `docs/decisions/0003-physician-stated-source.md`); a check against a public SMART sandbox, OpenEMR or a hospital EHR; a transcription benchmark on human speech.

## Commits of this brief

| Phase | Commit |
| --- | --- |
| 0 claims | `32d37ac` |
| 1 real chart in, cited draft out | `83e5996`, `eb3d5dc`, `1eb398a`, `ab8b1af` |
| 2 design system and UI | `f5d8fbd`, `dfa43d4` |
| 3 scribe and EHR write-back | `4ee45c7`, `5bc29fa` |
| 4 specialist inbox | `96e6d4e` |
| 5 operations and docs | `fdc951b`, and the commit that added this file |

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
- A synthetic staging app for browser work: PostgreSQL 17 in Docker on a loopback port, `STETHOLINK_TEST_OWNER_URL=... node tests/e2e/m3-migrations.mts` to apply migrations (fresh database each time; history is append-only), then `VERCEL_ENV=preview AUTH_MODE=staging STAGING_LAUNCH_SECRET=<32+ chars> STETHOLINK_DATABASE_URL=postgres://stetholink_runtime@127.0.0.1:<port>/postgres AI_PROVIDER=mock CLINICAL_DATA_SOURCE=synthetic SCRIBE_ENABLED=true npx next dev apps/embedded-app -p 3100`.

## Handing off

The owner asked that each step end with a fresh session, to keep context small without lowering quality: finish one step, run the checks that step needs, commit and push, update this file, then start a new session with a short prompt that points here.
