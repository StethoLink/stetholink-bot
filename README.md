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
2. Type a request such as *Prepare a cardiology consultation about blood pressure control* and choose **Prepare consultation**.
3. For API verification, open [the health endpoint](http://localhost:3000/api/health).

This quick start keeps drafts in memory and uses the deterministic fallback, which the interface labels as not being AI. Development auth can prepare drafts only: physician decisions, sending, specialist responses and history need the verified synthetic staging session and PostgreSQL, which the full demonstration starts for you.

## Full demonstration (assistant, review, approval, provider, response, history)

Requires Node.js 22 and Docker Desktop. From the repository root:

```powershell
npm ci
npm run demo
```

Open the link the command prints (`http://127.0.0.1:3000/staging#secret=…`), keep **Omar (fictional chest-pain case)** selected and choose **Open synthetic chart**.

1. Type *Prepare a cardiology consultation for this patient regarding possible acute coronary syndrome.* and choose **Prepare consultation**. The draft shows the clinical question, documented findings with their chart sources, missing information and AI suggestions.
2. Select a **Source:** link to see the chart fact behind a statement.
3. Under **Ask the assistant to revise this draft**, type *Make it shorter and focus on the ECG findings.* The revised draft returns for your review.
4. **Approve**, choose **Synthetic Cardiology Consult Service (simulated)**, then **Confirm approve**. Nothing can be sent before this step, and it can only be sent to the approved provider.
5. **Send approved consultation**, then **Simulate the provider's next reply** twice: the provider accepts, then its response appears, labelled as simulated.
6. Reload the page: the consultation is under **Consultations for this chart** with its response.

To use a real model, set these before `npm run demo` (see [the assistant guide](docs/ai/consultation-assistant.md)):

```powershell
$env:AI_PROVIDER = "openai"
$env:OPENAI_API_KEY = "<server-side key>"
$env:OPENAI_MODEL = "<model id>"
$env:OPENAI_INPUT_USD_PER_MILLION = "<upper bound you accept>"
$env:OPENAI_OUTPUT_USD_PER_MILLION = "<upper bound you accept>"
```

Only fictional charts are sent to the model. The specialist is always the built-in simulated provider: no real provider is integrated. The other synthetic providers show failure handling (*unreachable* fails and can be retried; *declines requests* refuses). `npm run demo` starts a throwaway local PostgreSQL container and removes it on exit; set `DEMO_DATABASE_OWNER_URL` to an empty local PostgreSQL to keep data between runs.

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
