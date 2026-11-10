# OpenEMR and FHIR sandbox

Use a synthetic chart, a trusted TLS certificate, a single development server, and an existing Supabase clinician account. The clinician must have an active StethoLink Supabase session in the same browser before launching from the EHR. The existing `POST /api/auth/login` endpoint accepts the account's email and password and establishes the session in HTTP-only cookies.

Register a public SMART client on the EHR. Set its launch URL to `https://<app-host>/api/smart/launch` and its redirect URI to `https://<app-host>/api/smart/callback`. Use a top-level launch for the sandbox so session cookies are available during the redirects.

Set the following in `apps/embedded-app/.env.local` and restart the app.

| Variable | Value |
| --- | --- |
| `AUTH_MODE` | `supabase` |
| `NEXT_PUBLIC_SUPABASE_URL` | Dedicated tenant's Supabase URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | That project's public key |
| `CLINICAL_DATA_SOURCE` | `openemr` or `fhir` |
| `FHIR_BASE_URL` | Exact issuer URL sent in the EHR launch, including its site-specific FHIR path |
| `SMART_CLIENT_ID` | Registered public client ID |
| `SMART_AUTHORIZATION_URL` | Authorization endpoint from the trusted EHR SMART configuration |
| `SMART_TOKEN_URL` | Token endpoint from that configuration |
| `SMART_REDIRECT_URI` | Exact registered HTTPS callback |
| `SMART_SCOPE` | EHR-supported launch and patient-scoped reads/searches for Patient, Encounter, AllergyIntolerance, Condition, and MedicationRequest |
| `NEXT_PUBLIC_API_MODE` | `http` |
| `AI_PROVIDER` | `mock` |

Run `npm run dev -- --experimental-https` with an app certificate trusted by the browser. If your OpenEMR at `https://localhost` uses a private CA, configure Node to trust it with `NODE_EXTRA_CA_CERTS` before starting the server. Launch StethoLink from the synthetic patient chart. On success the app renders the patient and, when available, the launch encounter.

The connector accepts a supported single-page R4 search result. It rejects incomplete paginated results. The sandbox does not expose EHR data to the model and does not write back to the EHR. It has not been validated against the local OpenEMR instance.

Protocol reference. [HL7 SMART App Launch](https://hl7.org/fhir/smart-app-launch/STU2.2/app-launch.html)
