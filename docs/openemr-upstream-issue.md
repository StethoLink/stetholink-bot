# Issue text for OpenEMR (to be filed by the owner)

Not filed. Search https://github.com/openemr/openemr/issues for `checkUserHasAccessToPatient` first; if an issue exists, add the reproduction there instead.

---

**Title:** SMART EHR launch: every `patient/*` FHIR read answers 401 since 8.4.0 (numeric user id passed to `checkUserHasAccessToPatient`, which expects a UUID)

**Versions:** 8.4.0, 8.4.1, 8.5.0, 8.6.0 and `master` (read on 2026-11-15). Reproduced on the official Docker image `openemr/openemr:8.5.0`. Not present in 7.0.3 (verified) or in 7.0.4 to 8.3.0, where the check returns `true`.

**What happens:** A public SMART app launched from the patient dashboard by a clinician (role `users`), with scopes `launch openid fhirUser patient/Patient.rs patient/Encounter.rs ...`, receives a token with `patient` and `encounter`. Every request with that token to a patient-scoped resource (`GET /apis/default/fhir/Patient/<uuid>`, `GET /apis/default/fhir/Encounter/<uuid>`) answers 401. The log holds:

```
OpenEMR Error: checkUserHasAccessToPatient rejected — user id missing or not a valid UUID {"userIdType":"integer"}
OpenEMR Error: api had patient launch scope but user did not have access to patient uuid. Resources restricted with patient scopes will not return results
```

**Cause:** in `src/RestControllers/Authorization/BearerTokenAuthorizationStrategy.php`, `populateTokenContextForRequest()` calls

```php
if ($this->checkUserHasAccessToPatient($restRequest->getRequestUserId(), $patientUuid)) {
```

`HttpRestRequest::getRequestUserId()` returns `?int` (the numeric `users.id`). Since 8.4.0 `checkUserHasAccessToPatient()` starts with `if (!is_string($userId) || ... || !UuidRegistry::isValidStringUUID($userId)) { return false; }` and then calls `getUserByUUID($userId)`. An integer never passes, so the patient is never bound to the request, for any user.

**Suggested fix:** pass the UUID the method documents:

```php
if ($this->checkUserHasAccessToPatient($restRequest->getRequestUserUUIDString(), $patientUuid)) {
```

**Steps to reproduce:**

1. Start `openemr/openemr:8.5.0` with the REST and FHIR APIs enabled and the Site Address set.
2. Register a public client with `initiate_login_uri`, a redirect URI and the scopes above; enable it in Admin, System, API Clients.
3. Give the signed-in user an NPI. Create a patient and open an encounter.
4. Launch the app from "SMART Enabled Apps" on the patient dashboard, sign in and authorize.
5. Exchange the code, then `GET /apis/default/fhir/Patient/<patient from the token>` with the access token: 401.

The same steps on 7.0.3 return the patient.
