# OpenEMR and FHIR SMART launch

How to plug StethoLink into OpenEMR so that it opens from the patient's chart. The steps were run against real OpenEMR 7.0.3 and 8.5.0 in Docker on 2026-11-15; what was and was not verified is at the end. Use a test patient created inside the EHR, never a real person's record.

## OpenEMR versions

| OpenEMR | Launch from the chart |
| --- | --- |
| 7.0.3 (patch 4) | **Works unpatched.** Verified end to end. |
| 7.0.4 to 8.3.0 | Not run. The source of the faulty check below returns "allowed" in these versions, so the fault is not present. |
| 8.4.0, 8.4.1, 8.5.0, 8.6.0 | **Fails in OpenEMR.** Reproduced on unpatched 8.5.0; the same code is in the 8.4.0, 8.4.1 and 8.6.0 releases and on `master` (2026-11-15). |

The fault in 8.4.0 and later: `BearerTokenAuthorizationStrategy::populateTokenContextForRequest()` calls `checkUserHasAccessToPatient($restRequest->getRequestUserId(), $patientUuid)`. `getRequestUserId()` returns the numeric `users.id`; since 8.4.0 the check refuses anything that is not a UUID string. The launched patient is therefore never bound to the request, and every `patient/*` FHIR read answers 401. OpenEMR's log says `checkUserHasAccessToPatient rejected — user id missing or not a valid UUID {"userIdType":"integer"}`; StethoLink's log says `fhir_patient_unreadable` with `http:401`. It affects every SMART app that uses patient scopes with a clinician's sign-in, not only StethoLink.

StethoLink does not ship or need a patched OpenEMR. Until OpenEMR fixes it, use a version that is not affected, or apply the vendor's fix when it is released. The fix belongs in OpenEMR: pass `$restRequest->getRequestUserUUIDString()` to the check. The issue text for OpenEMR is in [openemr-upstream-issue.md](openemr-upstream-issue.md).

## 1. OpenEMR settings

In Admin, Config, Connectors:

- Enable the standard REST API and the FHIR REST API.
- **Site Address (required for OAuth2 and FHIR)**: the exact public HTTPS origin of OpenEMR, for example `https://emr.hospital.example`, no trailing slash. OpenEMR builds `iss`, its endpoints and every signed `fhirUser` from it. If it differs from the address the server uses, discovery or the clinician mapping fails.

Every clinician who will use StethoLink needs an **NPI** on their OpenEMR user (Admin, Users). Without one OpenEMR signs the user as `Person/<uuid>`, not `Practitioner/<uuid>`, and the launch stops with `clinician_not_practitioner`.

## 2. Register the client

Register a **public** client, in Admin, System, API Clients, "Register New App" (`/interface/smart/register-app.php`), or by request:

```sh
curl -X POST https://<openemr>/oauth2/default/registration -H 'Content-Type: application/json' -d '{
  "application_type": "public",
  "client_name": "StethoLink",
  "redirect_uris": ["https://<app-host>/api/smart/callback"],
  "initiate_login_uri": "https://<app-host>/api/smart/launch",
  "contacts": ["<admin email>"],
  "scope": "launch openid fhirUser patient/Patient.read patient/Encounter.read patient/AllergyIntolerance.read patient/Condition.read patient/MedicationRequest.read patient/Observation.read patient/Medication.read"
}'
```

- Send only these fields. OpenEMR refuses `"token_endpoint_auth_method": "none"` (`invalid_client_metadata`), and refuses the whole registration if one scope is not in its list (`invalid_scope`, naming the scope).
- `initiate_login_uri` is the launch URL. With it and the `launch` scope the app appears in the chart.
- Scopes: 7.0.3 knows only the SMART v1 names (`patient/Patient.read`). 8.x also lists the v2 names (`patient/Patient.rs`), but 8.5.0 does not list `patient/Medication.rs`. Use the names the preflight accepts, and put the same list in `SMART_SCOPE`. Add write scopes only if `EHR_WRITE_ENABLED` is used.
- Do not ask for `launch/patient`. With it OpenEMR treats the launch as standalone and leaves the visit out of the token. The server never sends it, whatever `SMART_SCOPE` holds.
- The answer holds the `client_id` for `SMART_CLIENT_ID`. It also holds a client secret and a registration token; StethoLink does not use them, do not store them.

## 3. Enable the client

A new client is **Disabled**. In Admin, System, API Clients (`/interface/smart/admin-client.php`), choose Edit on StethoLink, then **Enable Client**. Until then the launch ends with `authorization_denied`.

On the same page, the button labelled "Disable EHR Launch Authorization Flow" makes OpenEMR skip its own second sign-in and consent screen when the app is launched from the chart. Without it the clinician signs in again ("OpenEMR Login") and authorizes the scopes inside the StethoLink window on every launch. Both ways were run on 7.0.3 and both open the chart. Whether to skip is the hospital's decision.

## 4. StethoLink settings

| Variable | Value for OpenEMR (site `default`) |
| --- | --- |
| `CLINICAL_DATA_SOURCE` | `openemr` |
| `TENANT_ID` | Stable tenant identifier |
| `STETHOLINK_DATABASE_URL`, `STETHOLINK_DATABASE_CA` | Restricted runtime PostgreSQL connection and its CA |
| `FHIR_BASE_URL` | `<Site Address>/apis/default/fhir`, exactly, no trailing slash |
| `SMART_CLIENT_ID` | The `client_id` from the registration |
| `SMART_AUTHORIZATION_URL` | `<Site Address>/oauth2/default/authorize` |
| `SMART_TOKEN_URL` | `<Site Address>/oauth2/default/token` |
| `SMART_OIDC_ISSUER` | `<Site Address>/oauth2/default` |
| `SMART_JWKS_URL` | `<Site Address>/oauth2/default/jwk` |
| `SMART_REDIRECT_URI` | `https://<app-host>/api/smart/callback`, exactly as registered |
| `SMART_SCOPE` | The registered scope list. A resource the EHR does not grant is shown as "could not be loaded" |
| `SMART_CLINICIAN_MAP` | Server-side JSON list of `subject`, `fhirUser`, `clinicianId` (UUID) and `role` (`clinician` or `physician`) |
| `NODE_EXTRA_CA_CERTS` | PEM file with the CA of OpenEMR's certificate, when it is not a public CA |
| `COOKIE_MODE` | `lax` when StethoLink is on the same site as OpenEMR (preferred), `embedded` when it is on another site. See 5a |
| `EHR_FRAME_ORIGINS` | Optional. Only if OpenEMR's pages are on another origin than its sign-in. See 5a |
| `UI_DEFAULT_LOCALE` | Optional. `en` (default) or `ar` |

### The clinician map

OpenEMR signs the user's UUID as the subject, and `<FHIR_BASE_URL>/Practitioner/<the same UUID>` as `fhirUser`. So an entry is:

```json
{ "subject": "<user uuid>", "fhirUser": "Practitioner/<user uuid>", "clinicianId": "<a UUID you assign>", "role": "physician" }
```

`fhirUser` may be written relative (`Practitioner/<uuid>`) or absolute (`<FHIR_BASE_URL>/Practitioner/<uuid>`); both match what OpenEMR signs. Nothing else matches: the subject must be equal, and the `fhirUser` must be the same resource type and id on exactly `FHIR_BASE_URL` (another host, port, path or scheme does not match). The user's UUID, from the OpenEMR database:

```sql
SELECT username, LOWER(CONCAT_WS('-', SUBSTR(HEX(uuid),1,8), SUBSTR(HEX(uuid),9,4), SUBSTR(HEX(uuid),13,4), SUBSTR(HEX(uuid),17,4), SUBSTR(HEX(uuid),21))) AS uuid, npi FROM users WHERE username = '<login>';
```

Every mapped clinician can draft; only a mapped `physician` can approve and send. Update the map and revoke affected sessions when access changes.

## 5. TLS

**Server to OpenEMR.** StethoLink's server fetches discovery, the token endpoint, the signing keys and the chart. It trusts Node's public CAs plus the file in `NODE_EXTRA_CA_CERTS`, which Node reads once at start and ignores without an error if it is unreadable. With OpenEMR's self-signed or hospital-CA certificate missing from that file, the launch stops with `discovery_unreachable`. Do not start the app with `next dev --experimental-https`: it replaces this setting, so the server can no longer verify OpenEMR. Serve the app over HTTPS from a reverse proxy in front of `next start` instead, and keep `NODE_EXTRA_CA_CERTS` in the server's own environment.

**Browser to StethoLink.** OpenEMR opens StethoLink in a frame inside its own page. A browser offers no "accept this certificate" page inside a frame, so with a certificate the browser does not trust the frame stays empty, and nothing in StethoLink can change that. Give the app a certificate the clinicians' browsers already trust (a public CA, or the hospital CA installed on the workstations). StethoLink never works around it with a new tab or window.

## 5a. Inside the OpenEMR window: frame, cookies, nothing outside

StethoLink runs in the frame OpenEMR opens for it and never leaves it: it opens no popup, no new window and no tab, and the only address it sends the frame to outside itself is OpenEMR's own sign-in page during the launch.

**Who may frame it.** Every response carries `Content-Security-Policy: ... frame-ancestors <EHR origin>`. The origin is the one of `SMART_AUTHORIZATION_URL` (OpenEMR's Site Address). No other site can put StethoLink in a frame. If the EHR's pages are served from another origin than its sign-in, list the origins in `EHR_FRAME_ORIGINS` (HTTPS origins separated by spaces; no path, no wildcard; the server refuses to start on anything else).

**What the page may load or call.** The same header allows scripts, styles, fonts, images, requests, media and workers from StethoLink's own origin only. There is no font service, analytics, error tracker or CDN, and the browser would block one. `tests/backend/no-third-party-runtime.test.ts` fails the build if code for one is added.

**Cookies.** The pending launch and the session are cookies set inside the frame. Two setups work; choose by where StethoLink is served.

| Setup | `COOKIE_MODE` | Cookies | When |
| --- | --- | --- | --- |
| **Same site as the EHR (preferred)** | `lax` (default) | `SameSite=Lax; Secure; HttpOnly` | StethoLink and OpenEMR share a registrable domain, for example `stetholink.hospital.example` and `emr.hospital.example`, behind the hospital's reverse proxy |
| Another site | `embedded` | `SameSite=None; Secure; HttpOnly; Partitioned` | StethoLink is hosted on a different domain than the EHR |

With `lax` on another site the browser withholds the cookies in the frame and the callback ends with `launch_session_missing`. `Partitioned` cookies need a current Chrome or Edge (114 or later), Firefox 131 or later, or Safari 18.4 or later; on an older browser use the same-site setup.

**Same site behind the hospital's reverse proxy.** Give StethoLink a host name under the hospital's domain and terminate TLS at the proxy with the hospital's certificate. Forward the `Host` header unchanged (StethoLink compares it with the request's origin) and do not cache. For nginx:

```nginx
server {
  listen 443 ssl;
  server_name stetholink.hospital.example;              # same registrable domain as emr.hospital.example
  ssl_certificate     /etc/ssl/hospital/stetholink.crt;  # a certificate the workstations already trust
  ssl_certificate_key /etc/ssl/hospital/stetholink.key;
  client_max_body_size 30m;                              # scribe audio is uploaded in parts
  location / {
    proxy_pass http://127.0.0.1:3000;                    # the StethoLink container
    proxy_set_header Host $host;                         # required: the same-origin check reads it
    proxy_set_header X-Forwarded-Proto https;
    proxy_http_version 1.1;
    proxy_read_timeout 180s;                             # a draft can take up to two minutes
    proxy_buffering off;
  }
}
```

Set `SMART_REDIRECT_URI=https://stetholink.hospital.example/api/smart/callback`, register the same address in OpenEMR, keep `COOKIE_MODE=lax`. The proxy must not add `X-Frame-Options` and must not replace the `Content-Security-Policy` header.

**Microphone.** OpenEMR 7.0.3 creates the frame without `allow="microphone"`, so the browser refuses the microphone there and the scribe says so instead of recording. StethoLink does not open a window to get around it. Recording inside OpenEMR needs OpenEMR to add `allow="microphone"` to the frame it opens for SMART apps; consultations and the chart work without it.

**Language.** The panel is in English or Arabic (right to left). `UI_DEFAULT_LOCALE=en|ar` sets the hospital's default; a clinician switches with the button at the bottom of the panel and the choice is remembered in a cookie (`stetholink_locale`, holding `en` or `ar`).

### Checking the embedded frame

`tests/e2e/browser/openemr-frame.mjs` drives a real OpenEMR in Chromium (Playwright; not a project dependency and not part of `npm run check`). It signs in, opens the chart of a patient **created in that OpenEMR for testing**, opens or creates a visit, presses the app's Launch button and then checks: StethoLink is in a frame of the OpenEMR page; no window or tab was opened; every StethoLink response carries the policy with OpenEMR's origin; no StethoLink page asked for anything outside its own origin; the panel is not wider than its frame; the application's own font loaded; the first Tab lands on a visible focus ring. It prints the session cookie's attributes as the browser stored them.

```sh
OPENEMR_URL=https://localhost:9300 OPENEMR_USER=admin OPENEMR_PASS=<password> APP_ORIGIN=https://127.0.0.1:3082 \
APP_NAME=StethoLink OPENEMR_PID=1 VISIT=<encounter number, "none", or empty to create one> FRAME_WIDTH=360 UI=ar SHOTS=out \
NODE_PATH=/opt/node-tools/node_modules node tests/e2e/browser/openemr-frame.mjs
```

`EXPECT=no-visit` (with `VISIT=none`) expects the "open a visit" page with its reference; `EXPECT=not-shared` expects the notice for records the registration does not grant. `localhost` and `127.0.0.1` are different sites to a browser, so one machine can run the cross-site case.

## 6. Preflight

Before asking a clinician to sign in, run the preflight with the server's environment, including `NODE_EXTRA_CA_CERTS`:

```sh
node --env-file=.env.local scripts/smart-preflight.mts     # or: npm run smart:preflight
```

It signs nobody in and reads no chart. Each line is `PASS` or `FAIL` with what to fix; the exit code is 1 if a check failed. It checks: the settings are present; every endpoint is plain HTTPS and the redirect URI is the callback; the scope has `launch`, `openid` and `fhirUser`; the clinician map is well formed and every `fhirUser` is a clinician on `FHIR_BASE_URL` (entries are named by position, values are never printed); the CA file is readable and not expired; a TLS handshake to every host the server calls succeeds with the server's trust; SMART discovery answers, publishes exactly the pinned endpoints, offers PKCE S256 and EHR launch, and lists every requested scope; the OpenID configuration publishes exactly `SMART_OIDC_ISSUER` and `SMART_JWKS_URL`; the JWKS holds a usable signing key; the FHIR API answers.

It cannot see what only a sign-in shows: that the client is enabled, that the signed subject is in the map, that a visit is open, and that OpenEMR lets the clinician read the chart.

## 7. Launch

1. Sign in to OpenEMR and open the patient's chart.
2. **Open a visit.** The chart header must show "Open Encounter: <date>", not "Open Encounter: None". OpenEMR puts a visit in the token only while one is open. Without it StethoLink answers "Open a visit in the patient's chart, then launch StethoLink again."
3. On the patient dashboard, in "SMART Enabled Apps", press **Launch** next to StethoLink. It opens in a window inside OpenEMR.
4. Unless the skip from section 3 is on, choose "OpenEMR Login", sign in, and press Authorize.
5. StethoLink shows the patient's name and the visit. If it shows an error, read the next section with the reference from the page.

## When a launch fails

The browser shows an error page with a short reference, for example `3FA9-01BC-77D2`. The server log holds one JSON line for that request with the same reference and the reason:

```json
{"action":"smart.launch_failed","stage":"callback","reason":"clinician_unmapped","detail":"fhir_user:absolute_on_issuer","correlationId":"3FA9-01BC-77D2","at":"..."}
```

The line never contains a token, an authorization code, the state or nonce, the subject, a `fhirUser` value, a patient or encounter identifier, a URL or the EHR's error text. `detail` is a fixed word: the name of a check or claim, an HTTP status, or the form of a value. The clinician is told the reason only when they can act on it (no open visit, or a visit StethoLink cannot use); every other failure shows the same generic message.

| `reason` | Stage | Meaning and what to check |
| --- | --- | --- |
| `launch_malformed` | launch | The EHR did not send exactly one `iss` and one `launch`. Check the launch URL registered in the EHR. |
| `not_configured` | both | A `SMART_*` or `FHIR_BASE_URL` setting is empty. The server also refuses to start in that state, so this is seen only if the configuration check was bypassed. |
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
| `clinician_unmapped` | callback | No `SMART_CLINICIAN_MAP` entry is this user. `detail` starting with `subject:` means no entry has the signed subject; starting with `fhir_user:` means the subject matched and the `fhirUser` names another resource. The rest is the form of the signed `fhirUser`: `relative` (`Practitioner/<id>`), `absolute_on_issuer` (`<FHIR_BASE_URL>/Practitioner/<id>`), `absolute_elsewhere` (a URL that is not on `FHIR_BASE_URL`: compare scheme, host, port and path with OpenEMR's Site Address) or `other`. The relative and the absolute form of the same clinician both match, so with `fhir_user:` check the id itself. |
| `clinician_not_practitioner` | callback | The subject is in the map, and the EHR signed `Person/<id>` instead of `Practitioner/<id>`. OpenEMR does this for a user who has no NPI. Give the user an NPI in OpenEMR (Admin, Users), then launch again. |
| `clinician_reference_invalid` | callback | The mapped `fhirUser` is not a `Practitioner` or `PractitionerRole` reference. |
| `missing_encounter` | callback | The token has no encounter. In OpenEMR the chart header says "Open Encounter: None". The clinician is told: "Open a visit in the patient's chart, then launch StethoLink again." |
| `fhir_patient_unreadable`, `fhir_encounter_unreadable` | callback | The FHIR read of the launched patient or visit failed. `detail`: the HTTP status (`http:401`, `http:403`), `empty` (not found, or the resource does not match the launch: another ID, or a visit of another patient), `request_failed` (no answer). `http:401` on both, straight after a sign-in that worked, on OpenEMR 8.4.0 or later is the OpenEMR fault described under "OpenEMR versions". |
| `encounter_unsupported` | callback | The visit exists but its status, type or start time cannot be used. The clinician is told why. |
| `grant_expired` | callback | The grant ran out before the session was saved. |
| `unexpected` | both | A fault outside the launch checks, for example the session store. Look for the neighbouring error line. |

The EHR must return patient and encounter context and support the requested FHIR operations. The connector follows paged search results (`next` links on the same FHIR base only, up to 5 pages of 100 per list) and tells the clinician when a list was longer. It accepts the R4 and R5 shapes of the encounter class, status and reason; a visit it cannot use is refused at launch with the reason. Every mapped clinician can draft; only a mapped physician can approve and send. The SMART flow has signed protocol tests with a fictional issuer. [HL7 SMART App Launch](https://hl7.org/fhir/smart-app-launch/STU2.2/app-launch.html)

## What was verified

Run on 2026-11-15 in Docker, with a fictional patient and visit created inside each OpenEMR, the production build of StethoLink behind a local HTTPS proxy, and a real browser (Chromium) driving OpenEMR's own pages:

- **OpenEMR 7.0.3, unpatched:** registration by request; the client enabled in the admin page; launch from the patient dashboard; OpenEMR's sign-in and consent; callback; StethoLink rendered the patient and visit inside the OpenEMR window. Also with the authorization-flow skip on. On the way, each of these stopped the launch with the reason this page gives: an untrusted certificate (`discovery_unreachable`, preflight `FAIL tls`), an unmapped user (`clinician_unmapped`), a user without NPI (`clinician_not_practitioner`), no open visit (`missing_encounter`). The map held the relative `fhirUser`, OpenEMR signed the absolute one.
- **OpenEMR 8.5.0, unpatched:** the same steps up to the callback, which failed with `fhir_patient_unreadable` (`http:401`) for the reason under "OpenEMR versions". The preflight also found that 8.5.0 does not list `patient/Medication.rs`.

Not verified: a browser that checks certificates (the test browser was told to accept the local test certificates); StethoLink and OpenEMR on different sites (both were on `localhost`, so cookies were same-site); the admin menu paths as a person clicks them (the pages were opened by address); OpenEMR 7.0.4 to 8.4.1 and 8.6.0 running (source read only); a hospital's own OpenEMR and single sign-on; anything after the first screen (scribe, drafts, write-back are T7). Test set-up that did not go through OpenEMR's screens: the patient was created with OpenEMR's patient service from the command line, and the user's NPI was set in the database. OpenEMR's FHIR API reports the visit as `finished` while it is still open in the chart.
