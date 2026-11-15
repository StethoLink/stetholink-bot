import "server-only";
import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import { z } from "zod";
import { beginSmartLaunch, checkSmartDiscovery, clinicianReference, ehrLaunchScope, parseClinicianMap, exchangeSmartCode, sameFhirUser, secureEndpoint, SmartDiscoveryError, SmartExchangeError, type SmartRegistration } from "@/integrations/fhir/smart";
import { createFhirConnector, FhirReadError } from "@/integrations/fhir/connector";
import { getEnv, specialistMap } from "@/platform/tenants/env";
import { saveSpecialistSession } from "./specialist-session";
import { RouteError } from "@/core/errors";
import { ChartUnavailableError } from "@/core/tools/connector";
import { AuthError, cookieOptions, saveSession } from "./session";
import { launchCookie, readHandle, sessionCookie, storeHandle } from "./session-store";
import type { IdentityAdapter } from "./identity";
import { observeSmartLaunch, SmartLaunchFailure } from "./smart-launch-failure";

const TOKEN_CLAIMS = ["iss", "sub", "aud", "exp", "iat", "nbf", "nonce", "fhirUser"];

const pendingSchema = z.object({ state: z.string(), verifier: z.string(), nonce: z.string(), issuer: z.string(), expiresAt: z.number() });
const MISSING_ENCOUNTER_MESSAGE = "Open a visit in the patient's chart, then launch StethoLink again.";

export { ehrLaunchScope };

function registration() {
  const env = getEnv();
  if (env.AUTH_MODE !== "smart" || env.CLINICAL_DATA_SOURCE === "synthetic" ||
      !env.FHIR_BASE_URL || !env.SMART_CLIENT_ID || !env.SMART_AUTHORIZATION_URL || !env.SMART_TOKEN_URL ||
      !env.SMART_REDIRECT_URI || !env.SMART_SCOPE || !env.SMART_OIDC_ISSUER || !env.SMART_JWKS_URL || !env.SMART_CLINICIAN_MAP) {
    throw new SmartLaunchFailure("not_configured", undefined, new RouteError("not_implemented", "SMART launch is not configured"));
  }
  const invalid = (detail: string) => new SmartLaunchFailure("registration_invalid", detail, new RouteError("provider_unavailable", "SMART registration is invalid"));
  const parsed = parseClinicianMap(env.SMART_CLINICIAN_MAP);
  if ("problem" in parsed) throw invalid(parsed.problem);
  const mapping = parsed.mapping;
  const reg = {
    issuer: env.FHIR_BASE_URL, authorizationEndpoint: env.SMART_AUTHORIZATION_URL, tokenEndpoint: env.SMART_TOKEN_URL,
    clientId: env.SMART_CLIENT_ID, redirectUri: env.SMART_REDIRECT_URI, scope: ehrLaunchScope(env.SMART_SCOPE),
    oidcIssuer: env.SMART_OIDC_ISSUER, jwksUrl: env.SMART_JWKS_URL,
    // A verified SMART session is live only for a tenant configured for live clinical data.
    tenantId: env.TENANT_ID, dataClassification: env.CLINICAL_DATA_MODE, mapping,
  };
  try {
    secureEndpoint(reg.oidcIssuer);
    secureEndpoint(reg.jwksUrl);
  } catch { throw invalid("endpoint"); }
  if (!["launch", "openid", "fhirUser"].every((scope) => reg.scope.split(/\s+/).includes(scope))) throw invalid("scope");
  return reg;
}

type Registration = ReturnType<typeof registration>;
type Callback = { state: string; code: string };

type Verified = Awaited<ReturnType<IdentityAdapter<unknown>["verify"]>> | { specialist: import("@/platform/tenants/env").SpecialistEntry };
function smartIdentityAdapter(reg: Registration): { verify(launch: { pending: z.infer<typeof pendingSchema>; callback: Callback }): Promise<Verified> } {
  return {
    async verify({ pending, callback }) {
      const result = await exchangeSmartCode(reg, pending, callback).catch((error: unknown) => {
        if (error instanceof SmartExchangeError) throw new SmartLaunchFailure(error.reason, error.status ? `http:${error.status}` : undefined);
        throw error;
      });
      if (!result.idToken || !result.scope) throw new SmartLaunchFailure("id_token_missing", result.idToken ? "scope" : "id_token");
      const scopes = result.scope.split(/\s+/).filter(Boolean);
      if (!scopes.includes("openid") || !scopes.includes("fhirUser")) throw new SmartLaunchFailure("identity_scopes_missing");

      // A key the server could not fetch is an infrastructure fault; a token that fails against fetched keys is not.
      const remoteKeys = createRemoteJWKSet(secureEndpoint(reg.jwksUrl), { timeoutDuration: 5000 });
      let keysFailed = false;
      const keys: typeof remoteKeys = Object.assign(async (...args: Parameters<typeof remoteKeys>) => {
        try { return await remoteKeys(...args); }
        catch (error) {
          if (!(error instanceof errors.JWKSNoMatchingKey)) keysFailed = true;
          throw error;
        }
      }, remoteKeys);
      const { payload } = await jwtVerify(result.idToken, keys, {
        algorithms: ["RS256", "ES256"], issuer: reg.oidcIssuer, audience: reg.clientId,
        requiredClaims: ["iss", "sub", "aud", "exp", "iat", "nonce", "fhirUser"], maxTokenAge: "5m",
      }).catch((error: unknown) => {
        if (keysFailed) throw new SmartLaunchFailure("jwks_unavailable");
        if (error instanceof errors.JWKSNoMatchingKey) throw new SmartLaunchFailure("jwks_no_matching_key");
        // The name of the failing claim (never its value) tells a wrong issuer from a wrong client or a clock problem.
        const claim = error instanceof errors.JWTClaimValidationFailed || error instanceof errors.JWTExpired ? error.claim : undefined;
        throw new SmartLaunchFailure("id_token_invalid",
          claim && TOKEN_CLAIMS.includes(claim) ? `claim:${claim.toLowerCase()}`
            : error instanceof errors.JWSSignatureVerificationFailed ? "signature"
            : error instanceof errors.JOSEAlgNotAllowed ? "algorithm" : undefined);
      });
      if (payload.nonce !== pending.nonce) throw new SmartLaunchFailure("binding_failed", "check:nonce");
      if ((Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== reg.clientId) ||
          (payload.azp !== undefined && payload.azp !== reg.clientId)) throw new SmartLaunchFailure("binding_failed", "check:azp");

      if (payload.at_hash !== undefined) {
        const hash = createHash("sha256").update(result.grant.accessToken).digest().subarray(0, 16).toString("base64url");
        if (payload.at_hash !== hash) throw new SmartLaunchFailure("binding_failed", "check:at_hash");
      }

      // A specialist opening the inbox: the launch has no patient, and the signed identity is in the tenant's specialist map.
      // The EHR token is not kept: an inbox session reads no chart.
      if (!result.hasPatient) {
        const specialist = specialistMap(getEnv()).find((entry) => entry.subject === payload.sub && entry.fhirUser !== undefined && sameFhirUser(reg.issuer, payload.fhirUser, entry.fhirUser));
        // A clinician launch without a patient and an unregistered specialist look the same here.
        if (!specialist) throw new SmartLaunchFailure("missing_patient");
        return { specialist };
      }
      // The clinician is identified before anything about the visit is said to the browser.
      // The signed subject must equal the mapped one exactly. The signed fhirUser must be the mapped clinician
      // resource on the pinned FHIR base, written relative or absolute (OpenEMR signs the absolute form).
      const mapped = reg.mapping.find((entry) => entry.subject === payload.sub && sameFhirUser(reg.issuer, payload.fhirUser, entry.fhirUser));
      if (!mapped) {
        // Which half of the pair did not match, and the form of the signed fhirUser. Neither value is logged.
        const signed = clinicianReference(reg.issuer, payload.fhirUser);
        const subjectMapped = reg.mapping.some((entry) => entry.subject === payload.sub);
        // A mapped user whom the EHR signs as a Person, not a Practitioner (in OpenEMR: the user has no NPI).
        if (subjectMapped && signed.person) throw new SmartLaunchFailure("clinician_not_practitioner");
        throw new SmartLaunchFailure("clinician_unmapped", subjectMapped ? `fhir_user:${signed.form}` : `subject:fhir_user_${signed.form}`);
      }
      const ehrUser = clinicianReference(reg.issuer, mapped.fhirUser).reference;
      if (!ehrUser) throw new SmartLaunchFailure("clinician_reference_invalid");
      // OpenEMR sends an encounter only while a visit is open in the chart. The clinician can fix this; it is not a refusal.
      if (!result.grant.encounterId) {
        throw new SmartLaunchFailure("missing_encounter", undefined, new ChartUnavailableError("unsupported_encounter", MISSING_ENCOUNTER_MESSAGE));
      }

      const adapter = createFhirConnector(result.grant);
      const [patientRead, encounterRead] = await Promise.allSettled([
        adapter.getPatient(result.grant.patientId), adapter.getEncounter(result.grant.encounterId),
      ]);
      const unreadable = (read: PromiseSettledResult<unknown>) => read.status === "fulfilled" ? "empty"
        : read.reason instanceof FhirReadError ? `http:${read.reason.status}` : "request_failed";
      if (patientRead.status === "rejected" || !patientRead.value) throw new SmartLaunchFailure("fhir_patient_unreadable", unreadable(patientRead));
      if (encounterRead.status === "rejected" && encounterRead.reason instanceof ChartUnavailableError) {
        // A visit StethoLink cannot use is reported to the clinician with its reason.
        throw new SmartLaunchFailure("encounter_unsupported", undefined, encounterRead.reason);
      }
      if (encounterRead.status === "rejected" || !encounterRead.value) throw new SmartLaunchFailure("fhir_encounter_unreadable", unreadable(encounterRead));
      const patient = patientRead.value, encounter = encounterRead.value;
      const expiresAt = Math.min(result.expiresAt, payload.exp! * 1000, Date.now() + 15 * 60_000);
      return {
        source: "smart",
        ehrAccessToken: result.grant.accessToken,
        ehrUser,
        context: {
          clinicianId: mapped.clinicianId, tenantId: reg.tenantId, roles: [mapped.role],
          // StethoLink permissions come from the tenant's clinician mapping, never from the EHR token:
          // every mapped clinician may draft; only a mapped physician may approve and send.
          // Recording a visit is open to every mapped clinician; approving a note and writing to the chart are the physician's.
          scopes: ["chart:read", "consultation:draft", "scribe:record", ...(mapped.role === "physician" ? ["consultation:approve", "consultation:route", "chart:write"] : []),
            ...scopes.map((scope) => "smart:" + scope)], patientId: patient.patientId, encounterId: encounter.encounterId,
          expiresAt, authorization: "active", dataClassification: reg.dataClassification,
        },
      };
    },
  };
}

async function discover(reg: SmartRegistration) {
  await checkSmartDiscovery(reg).catch((error: unknown) => {
    if (error instanceof SmartDiscoveryError) {
      throw new SmartLaunchFailure(error.reason, error.detail, new RouteError("provider_unavailable", "SMART discovery could not be verified"));
    }
    throw error;
  });
}

export function openSmartLaunch(issuer: string, launch: string, correlationId: string) {
  return observeSmartLaunch("launch", correlationId, async () => {
    const reg = registration();
    if (issuer !== reg.issuer || !launch || launch.length > 4096) {
      throw new SmartLaunchFailure("issuer_unregistered", issuer !== reg.issuer ? "issuer" : "launch", new AuthError("forbidden", "Unregistered SMART launch"));
    }
    await discover(reg);
    const { authorizationUrl, pending } = beginSmartLaunch(reg, issuer, launch);
    const jar = await cookies();
    await readHandle(jar.get(launchCookie)?.value, "launch", true);
    await readHandle(jar.get(sessionCookie)?.value, "session", true);
    jar.set(sessionCookie, "", cookieOptions(0));
    jar.set(launchCookie, await storeHandle("launch", pending, pending.expiresAt), cookieOptions(300));
    return authorizationUrl;
  });
}

export function finishSmartLaunch(callback: Callback, correlationId: string) {
  return observeSmartLaunch("callback", correlationId, async () => {
    const reg = registration();
    const jar = await cookies();
    const pending = pendingSchema.safeParse(await readHandle(jar.get(launchCookie)?.value, "launch", true));
    jar.set(launchCookie, "", cookieOptions(0));
    if (!pending.success) {
      throw new SmartLaunchFailure("launch_session_missing", undefined, new AuthError("forbidden", "SMART launch session is missing or expired"));
    }
    // Every failure has its reason in the log. The browser is told the reason only when the clinician can act on it
    // (no open visit, or a visit StethoLink cannot use); every other failure looks the same from outside.
    const verified = await smartIdentityAdapter(reg).verify({ pending: pending.data, callback }).catch((error: unknown) => {
      if (error instanceof SmartLaunchFailure) throw error;
      throw new SmartLaunchFailure("unexpected");
    });
    if ("specialist" in verified) {
      await saveSpecialistSession(verified.specialist);
      return "/inbox" as const;
    }
    if (verified.context.expiresAt <= Date.now()) throw new SmartLaunchFailure("grant_expired", undefined, new AuthError("forbidden", "SMART grant expired"));
    await saveSession(verified);
    return "/embed" as const;
  });
}
