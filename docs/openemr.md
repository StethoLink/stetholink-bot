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

The EHR must return patient and encounter context and support the requested FHIR operations. The connector follows paged search results (`next` links on the same FHIR base only, up to 5 pages of 100 per list) and tells the clinician when a list was longer. It accepts the R4 and R5 shapes of the encounter class, status and reason; a visit it cannot use is refused at launch with the reason. Every mapped clinician can draft; only a mapped physician can approve and send. The SMART flow has signed protocol tests with a synthetic issuer. A genuine OpenEMR or hospital SSO launch still requires verification. [HL7 SMART App Launch](https://hl7.org/fhir/smart-app-launch/STU2.2/app-launch.html)
