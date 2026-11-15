# StethoLink

StethoLink is a plugin inside the hospital EHR. A clinician opens it from the patient chart (SMART on FHIR) and can:

- **Record a visit** and get a SOAP note in which every statement points at the words that support it. After the physician approves, the note and the selected new items (for example an allergy) are created in the EHR.
- **Prepare a consultation** from the chart with a source for every statement, approve it, send it to a specialist service, read the reply and add it to the chart.

The EHR stays the source of truth. StethoLink registers no patients, has no separate sign-in for clinicians and keeps only working data: drafts, a temporary transcript and audit records. It contains no built-in patients, no stand-in model and no simulated specialist: without a real EHR, a real model and durable storage configured, the server refuses to start and says which setting is missing.

| To | Read |
| --- | --- |
| Deploy for a hospital pilot | [Go-live runbook](docs/go-live.md), [data map](docs/data-map.md) |
| Understand how it works and what guards it | [Architecture](docs/architecture/ARCHITECTURE.md) |
| See what was checked against real servers | [Sandbox checks](docs/sandbox.md) |
| See the transcription benchmark and cost per visit | [Scribe benchmark](docs/ai/scribe-benchmark.md) |
| See the interface | [Before and after](docs/ui/README.md) |

Docker and any PostgreSQL 15+ are enough to run it; nothing depends on a particular cloud.

## Run it

StethoLink has one mode. It needs:

- an EHR with SMART on FHIR (for a first run: [OpenEMR in Docker](docs/openemr.md), or a [FHIR sandbox](docs/sandbox.md)) with a test patient created inside that EHR;
- PostgreSQL 15+ with the migrations in `supabase/migrations` applied (`node scripts/migrate.mjs`);
- a model deployment with its key and verified rates.

Use Node.js 22 and npm. From the repository root:

```sh
cp .env.example apps/embedded-app/.env.local   # then fill in every value marked "required"
npm ci
npm run smart:preflight                        # checks the EHR registration before anyone signs in
npm run build && npm start
```

Then launch StethoLink from the patient chart in the EHR. Opening `/embed` directly shows "Open StethoLink from the patient chart": there is no other sign-in.

If a required setting is empty, or a setting of the removed synthetic modes is still present (`AI_PROVIDER=mock`, `CLINICAL_DATA_SOURCE=synthetic`, `AUTH_MODE=dev` or `staging`, `STAGING_LAUNCH_SECRET`, ...), the server exits at start with a line such as `StethoLink refused to start: StethoLink is not configured: CLINICAL_DATA_SOURCE must be set`. It names settings, never their values.

With Docker:

```sh
docker build -t stetholink .
docker run --rm -p 127.0.0.1:3000:3000 --env-file apps/embedded-app/.env.local stetholink
```

## Test data

Real patient data is never committed and never used in automated tests ([AGENTS.md](AGENTS.md)). Fictional charts, the deterministic model stand-in and the fake EHR, model and transcription servers live under `tests/` only. `npm run lint` and `npm run check` fail if `apps/`, `core/`, `platform/`, `integrations/`, `shared/` or `scripts/` import anything from `tests/`, a `fixtures` or a `mocks` folder.

## Verify

```sh
npm run check
npm run build
node --test tests/smoke/*.test.mts
bash tests/e2e/run-ci.sh   # Linux with Docker: the whole flow against fake EHR, model and transcription servers
```

The smoke tests use Node 22.18+ and need no dependency installation. See the [architecture](docs/architecture/ARCHITECTURE.md) and [SMART sandbox setup](docs/openemr.md) for integration boundaries and limitations.
