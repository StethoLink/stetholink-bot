/** A complete server configuration. Every value is fictional; no server exists at these addresses. */
export const completeConfig = {
  AUTH_MODE: "smart", CLINICAL_DATA_SOURCE: "fhir", TENANT_ID: "fictional-hospital",
  STETHOLINK_DATABASE_URL: "postgres://stetholink_runtime@db.example.test/postgres",
  AI_PROVIDER: "openai", MODEL_LIVE_DATA_APPROVED: "true", SESSION_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=", OPENAI_API_KEY: "fictional-key",
  OPENAI_INPUT_USD_PER_MILLION: "1", OPENAI_OUTPUT_USD_PER_MILLION: "2",
  FHIR_BASE_URL: "https://ehr.example.test/fhir", SMART_CLIENT_ID: "fictional-client", SMART_AUTHORIZATION_URL: "https://ehr.example.test/authorize",
  SMART_TOKEN_URL: "https://ehr.example.test/token", SMART_REDIRECT_URI: "https://stetholink.example.test/api/smart/callback",
  SMART_OIDC_ISSUER: "https://ehr.example.test", SMART_JWKS_URL: "https://ehr.example.test/jwks", SMART_SCOPE: "launch openid fhirUser patient/Patient.rs",
  SMART_CLINICIAN_MAP: JSON.stringify([{ subject: "fictional-subject", fhirUser: "Practitioner/fictional", clinicianId: "55555555-5555-4555-8555-555555555555", role: "physician" }]),
} as const;
