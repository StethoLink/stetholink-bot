# OpenEMR and FHIR SMART launch

Use a synthetic chart in a trusted EHR test environment. Register a public SMART client with launch URL `https://<app-host>/api/smart/launch` and exact redirect URI `https://<app-host>/api/smart/callback`. Start with a top-level launch to support SameSite=Lax cookies. Verify embedding with the hospital's supported browser and EHR configuration.

| Variable | Value |
| --- | --- |
| `AUTH_MODE` | `smart` |
| `CLINICAL_DATA_SOURCE` | `openemr` or `fhir` |
| `TENANT_ID` | Stable tenant identifier |
| `STETHOLINK_DATABASE_URL` | Restricted runtime PostgreSQL connection |
| `STETHOLINK_DATABASE_CA` | Trusted CA PEM if needed |
| `FHIR_BASE_URL` | Exact FHIR URL sent as `iss` |
| `SMART_CLIENT_ID` | Registered public client ID |
| `SMART_AUTHORIZATION_URL`, `SMART_TOKEN_URL` | Pinned endpoints from SMART discovery |
| `SMART_REDIRECT_URI` | Exact registered HTTPS callback |
| `SMART_OIDC_ISSUER`, `SMART_JWKS_URL` | Pinned OIDC issuer and JWKS URL |
| `SMART_SCOPE` | Include `launch openid fhirUser` and patient-scoped read and search for Patient, Encounter, AllergyIntolerance, Condition, MedicationRequest, Observation and Medication (`patient/Observation.rs` in SMART v2, `patient/Observation.read` in v1). A resource the EHR does not grant is shown as "could not be loaded" |
| `SMART_CLINICIAN_MAP` | Server-side JSON array of trusted `subject`, `fhirUser`, `clinicianId` (UUID) and `role` (`clinician` or `physician`) entries |

Use the exact signed `fhirUser` from the hospital's registration process, for example a relative `Practitioner/<id>` reference or its absolute equivalent on the pinned FHIR base. Obtain the subject and role through the hospital administrator. Update the mapping and revoke affected local sessions when access changes.

Do not put `launch/patient` in `SMART_SCOPE`. It asks for standalone patient context; when it is requested together with `launch`, OpenEMR treats the launch as standalone and leaves the encounter out of the token, so a launch from the chart cannot open a visit. An EHR launch takes its patient and encounter from `launch` alone. The server removes `launch/patient` from the authorization request if the setting still contains it.

## When a launch fails

The browser shows an error page with a short reference, for example `3FA9-01BC-77D2`. The server log holds one JSON line for that request with the same reference and the reason:

```json
{"action":"smart.launch_failed","stage":"callback","reason":"clinician_unmapped","detail":"fhir_user:absolute_on_issuer","correlationId":"3FA9-01BC-77D2","at":"..."}
```

The line never contains a token, an authorization code, the state or nonce, the subject, a `fhirUser` value, a patient or encounter identifier, a URL or the EHR's error text. `detail` is a fixed word: the name of a check or claim, an HTTP status, or the form of a value. The clinician is told the reason only when they can act on it (no open visit, or a visit StethoLink cannot use); every other failure shows the same generic message.

| `reason` | Stage | Meaning and what to check |
| --- | --- | --- |
| `launch_malformed` | launch | The EHR did not send exactly one `iss` and one `launch`. Check the launch URL registered in the EHR. |
| `not_configured` | both | `AUTH_MODE` is not `smart`, the data source is synthetic, or a `SMART_*` or `FHIR_BASE_URL` setting is empty. |
| `registration_invalid` | both | `detail`: `clinician_map` (not valid JSON or a field is wrong), `clinician_map_duplicate` (a subject or clinician ID appears twice), `scope` (`launch`, `openid` or `fhirUser` missing from `SMART_SCOPE`), `endpoint` (issuer or JWKS URL is not HTTPS), `fhir_base`. |
| `issuer_unregistered` | launch | `detail: issuer`: the `iss` the EHR sent is not exactly `FHIR_BASE_URL` (compare scheme, host, port, path and trailing slash). |
| `discovery_unreachable` | launch | The server could not fetch `<FHIR_BASE_URL>/.well-known/smart-configuration`: DNS, a certificate the server does not trust, a redirect, or a timeout. |
| `discovery_rejected` | launch | Discovery answered with the HTTP status in `detail`. |
| `discovery_invalid` | launch | Discovery is not the expected JSON. |
| `discovery_endpoint_mismatch` | launch | `detail: endpoint:authorization` or `endpoint:token`: the EHR publishes a different endpoint than `SMART_AUTHORIZATION_URL` or `SMART_TOKEN_URL`. |
| `pkce_s256_unsupported` | launch | The EHR does not list PKCE `S256`. |
| `authorization_denied` | callback | The EHR returned an error instead of a code: consent refused, the client is not enabled, or a scope was rejected. Look at the EHR's own log. |
| `callback_malformed` | callback | The callback had no single `code` and `state`. |
| `launch_session_missing` | callback | No pending launch for this browser: the launch cookie was blocked (third-party cookies in a frame), five minutes passed, or the callback was opened twice. |
| `callback_invalid` | callback | The `state` does not match the pending launch, or it expired. |
| `token_endpoint_unreachable` | callback | The server could not reach `SMART_TOKEN_URL` (DNS, certificate trust, redirect, timeout). |
| `token_exchange_rejected` | callback | The token endpoint refused the code with the HTTP status in `detail`: wrong client ID, redirect URI not exactly as registered, or a reused code. |
| `grant_invalid` | callback | The token answer is not a usable bearer grant (type, lifetime, or a malformed patient or encounter ID). |
| `id_token_missing` | callback | `detail: id_token` or `scope`: the token answer has no ID token or no scope. The `openid` scope was probably not granted. |
| `identity_scopes_missing` | callback | The granted scope lacks `openid` or `fhirUser`. |
| `jwks_unavailable` | callback | The server could not fetch or read `SMART_JWKS_URL`. |
| `jwks_no_matching_key` | callback | The JWKS has no key for this token: wrong JWKS URL, or the EHR rotated its keys. |
| `id_token_invalid` | callback | `detail`: `claim:iss` (the signed issuer is not `SMART_OIDC_ISSUER`), `claim:aud` (not `SMART_CLIENT_ID`), `claim:exp` or `claim:iat` (expired or clock difference above five minutes), `claim:fhiruser` and other `claim:` names (claim missing), `signature`, `algorithm`. |
| `binding_failed` | callback | `detail`: `check:nonce`, `check:azp` or `check:at_hash`. The token does not belong to this launch. |
| `missing_patient` | callback | The token has no patient and the user is not a registered specialist. The app was opened outside a patient's chart. |
| `clinician_unmapped` | callback | No `SMART_CLINICIAN_MAP` entry has this exact `subject` and `fhirUser`. `detail` starting with `subject:` means no entry has the signed subject; starting with `fhir_user:` means the subject matched and the `fhirUser` did not. The rest is the form of the signed `fhirUser`: `relative` (`Practitioner/<id>`), `absolute_on_issuer` (`<FHIR_BASE_URL>/Practitioner/<id>`), `absolute_elsewhere` or `other`. Write the map entry in the same form. |
| `clinician_reference_invalid` | callback | The mapped `fhirUser` is not a `Practitioner` or `PractitionerRole` reference. |
| `missing_encounter` | callback | The token has no encounter. In OpenEMR the chart header says "Open Encounter: None". The clinician is told: "Open a visit in the patient's chart, then launch StethoLink again." |
| `fhir_patient_unreadable`, `fhir_encounter_unreadable` | callback | The FHIR read of the launched patient or visit failed. `detail`: the HTTP status (`http:401`, `http:403`), `empty` (not found, or the resource does not match the launch: another ID, or a visit of another patient), `request_failed` (no answer). |
| `encounter_unsupported` | callback | The visit exists but its status, type or start time cannot be used. The clinician is told why. |
| `grant_expired` | callback | The grant ran out before the session was saved. |
| `unexpected` | both | A fault outside the launch checks, for example the session store. Look for the neighbouring error line. |

The EHR must return patient and encounter context and support the requested FHIR operations. The connector follows paged search results (`next` links on the same FHIR base only, up to 5 pages of 100 per list) and tells the clinician when a list was longer. It accepts the R4 and R5 shapes of the encounter class, status and reason; a visit it cannot use is refused at launch with the reason. Every mapped clinician can draft; only a mapped physician can approve and send. The SMART flow has signed protocol tests with a synthetic issuer. A genuine OpenEMR or hospital SSO launch still requires verification. [HL7 SMART App Launch](https://hl7.org/fhir/smart-app-launch/STU2.2/app-launch.html)
