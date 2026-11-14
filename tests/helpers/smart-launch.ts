import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { fictionalFhirResponse, FICTIONAL_ENCOUNTER_ID, FICTIONAL_PATIENT_ID } from "../fixtures/fhir-chart";

/**
 * A fictional EHR for tests: a SMART/OIDC issuer that signs real ID tokens, and a FHIR server
 * holding the fictional chart. Nothing here is a real hospital, clinician or patient.
 */
export const FAKE_EHR = {
  fhir: "https://ehr.example.test/fhir",
  oidc: "https://id.example.test",
  app: "https://app.example.test",
  clientId: "fictional-client",
  accessToken: "fictional-ehr-access-token",
  subject: "fictional-subject",
  fhirUser: "Practitioner/fic-doctor",
  clinicianId: "55555555-5555-4555-8555-555555555555",
} as const;

export function smartEnv(role: "physician" | "clinician") {
  return {
    AUTH_MODE: "smart", CLINICAL_DATA_SOURCE: "fhir", FHIR_BASE_URL: FAKE_EHR.fhir, SMART_OIDC_ISSUER: FAKE_EHR.oidc,
    SMART_JWKS_URL: FAKE_EHR.oidc + "/jwks", SMART_CLIENT_ID: FAKE_EHR.clientId, SMART_REDIRECT_URI: FAKE_EHR.app + "/api/smart/callback",
    SMART_AUTHORIZATION_URL: FAKE_EHR.oidc + "/authorize", SMART_TOKEN_URL: FAKE_EHR.oidc + "/token",
    SMART_SCOPE: "launch openid fhirUser patient/Patient.rs patient/Encounter.rs patient/Condition.rs patient/MedicationRequest.rs patient/AllergyIntolerance.rs patient/Observation.rs",
    SMART_CLINICIAN_MAP: JSON.stringify([{ subject: FAKE_EHR.subject, fhirUser: FAKE_EHR.fhirUser, clinicianId: FAKE_EHR.clinicianId, role }]),
  };
}

/** A `fetch` that plays the issuer and the FHIR server. `fhirOverride` replaces single FHIR answers. */
export async function fakeEhr(options: { scope?: string; fhirOverride?: (path: string, query: URLSearchParams) => unknown } = {}) {
  const keys = await generateKeyPair("ES256");
  const jwk = await exportJWK(keys.publicKey);
  const state = { nonce: "" };
  const env = smartEnv("physician");
  const request = async (target: URL | string | Request, init?: RequestInit) => {
    const url = new URL(String(target));
    if (url.origin === FAKE_EHR.oidc) {
      if (url.pathname === "/jwks") return Response.json({ keys: [jwk] });
      if (url.pathname === "/token") {
        const idToken = await new SignJWT({ nonce: state.nonce, fhirUser: FAKE_EHR.fhirUser }).setProtectedHeader({ alg: "ES256" })
          .setIssuer(FAKE_EHR.oidc).setAudience(FAKE_EHR.clientId).setSubject(FAKE_EHR.subject).setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
        // The EHR token never grants a StethoLink permission, whatever scope text it carries.
        return Response.json({ id_token: idToken, scope: options.scope ?? env.SMART_SCOPE, token_type: "Bearer", access_token: FAKE_EHR.accessToken,
          expires_in: 600, patient: FICTIONAL_PATIENT_ID, encounter: FICTIONAL_ENCOUNTER_ID });
      }
      return new Response(null, { status: 404 });
    }
    if (!url.href.startsWith(FAKE_EHR.fhir + "/")) return new Response(null, { status: 404 });
    const path = url.pathname.slice(new URL(FAKE_EHR.fhir).pathname.length);
    if (path === "/.well-known/smart-configuration") return Response.json({
      authorization_endpoint: env.SMART_AUTHORIZATION_URL, token_endpoint: env.SMART_TOKEN_URL, code_challenge_methods_supported: ["S256"],
    });
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${FAKE_EHR.accessToken}`) return new Response(null, { status: 401 });
    const body = options.fhirOverride?.(path, url.searchParams) ?? fictionalFhirResponse(path, url.searchParams);
    return body === undefined ? new Response(null, { status: 404 }) : Response.json(body);
  };
  return { request, state };
}

type Route = (request: Request) => Promise<Response>;

/** Runs the whole signed launch through the two SMART routes. Returns the callback response. */
export async function completeSmartLaunch(routes: { launch: Route; callback: Route }, ehr: Awaited<ReturnType<typeof fakeEhr>>) {
  const launch = await routes.launch(new Request(`${FAKE_EHR.app}/api/smart/launch?` + new URLSearchParams({ iss: FAKE_EHR.fhir, launch: "fictional-launch" })));
  if (launch.status !== 307) return launch;
  const params = new URL(launch.headers.get("location")!).searchParams;
  ehr.state.nonce = params.get("nonce")!;
  return routes.callback(new Request(`${FAKE_EHR.app}/api/smart/callback?` + new URLSearchParams({ code: "fictional-code", state: params.get("state")! })));
}
