# StethoLink

StethoLink is an EHR-embedded application for preparing, reviewing, and routing consultation requests. The same app and workflow can run with a synthetic connector or a hospital-specific connector.

## Run the synthetic workflow on Windows

Use Node.js 22 and npm. From the repository root in PowerShell:

```powershell
Copy-Item .env.example apps/embedded-app/.env.local
npm ci
npm run dev
```

1. Open [the synthetic patient chart](http://localhost:3000/embed?patientId=syn-pt-001&encounterId=syn-enc-001).
2. Choose **Prepare consultation for review** and review the draft.
3. Approve the draft, enter `synthetic-consult-team` as the approved recipient, and send it. The mock connector returns a synthetic acknowledgement.
4. For API verification, open [the health endpoint](http://localhost:3000/api/health).

The default configuration uses the app's HTTP routes, the mock model and the synthetic connector. Development auth can generate synthetic drafts. Physician decisions and mock delivery require the verified synthetic staging session and PostgreSQL. Set the permitted staging destinations with `MOCK_RECIPIENT_IDS`.

With Docker Desktop:

```powershell
docker build -t stetholink-dev .
docker run --rm -p 127.0.0.1:3000:3000 --env-file .env.example stetholink-dev
```

## Verify

```powershell
npm run check
npm run build
node --test tests/smoke/*.test.mts
```

The smoke tests use Node 22.18+ and need no dependency installation. See the [architecture](docs/architecture/ARCHITECTURE.md) and [SMART sandbox setup](docs/openemr.md) for integration boundaries and limitations.
