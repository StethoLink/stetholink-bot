# StethoLink

StethoLink is an EHR-embedded application for preparing, reviewing, and routing consultation requests. The same app and workflow can run with a synthetic connector or a hospital-specific connector.

## Run the synthetic workflow on Windows

Use Node.js 22 and npm. From the repository root in PowerShell:

```powershell
Copy-Item .env.example apps/embedded-app/.env.local
npm ci
npm run dev
```

1. Open [the synthetic patient chart](http://localhost:3000/embed).
2. Choose a specialty, enter a clinical question, choose **Prepare consultation for review**, and approve the draft.
3. For API verification, open [the health endpoint](http://localhost:3000/api/health).

This quick start keeps drafts in memory. Development auth can generate synthetic drafts only: physician decisions, sending, specialist responses and history need the verified synthetic staging session and PostgreSQL, which the full demonstration below starts for you. Set the permitted destinations with `MOCK_RECIPIENT_IDS`.

## Full synthetic demonstration (draft, approval, mock specialist, response)

Requires Node.js 22 and Docker Desktop. From the repository root:

```powershell
npm ci
npm run demo
```

Then open <http://127.0.0.1:3000/embed>. The chart is the fictional Ahmed cardiology case.

1. Enter a clinical question and choose **Prepare consultation for review**. The draft cites its source facts and lists what is missing (ECG, troponin and so on).
2. Optional: **Request changes**, edit the text, and **Save edits and return to review**.
3. **Approve**, choose **Synthetic Cardiology Consult Service** as the destination, then **Confirm approve**. Nothing can be sent before this step, and it can only be sent to the approved destination.
4. **Send approved consultation**.
5. Choose **Simulate specialist reply** twice: the provider accepts, then the specialist's response appears.
6. Reload the page, or stop and restart `npm run demo` against a kept database: the consultation is under **Consultations for this chart** with its response.

The other synthetic providers show failure handling: *unreachable* fails and can be retried; *declines requests* refuses the consultation. `npm run demo` starts a throwaway local PostgreSQL container and removes it on exit; set `DEMO_DATABASE_OWNER_URL` to an empty local PostgreSQL to keep data between runs. No real patient data, provider or network destination is involved.

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
