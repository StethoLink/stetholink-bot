import "server-only";
import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import { z } from "zod";
import { beginSmartLaunch, exchangeSmartCode, secureEndpoint, SmartExchangeError, type SmartRegistration } from "@/integrations/fhir/smart";
import { createFhirConnector, FhirReadError, isFhirId } from "@/integrations/fhir/connector";
import { getEnv, specialistMap } from "@/platform/tenants/env";
import { saveSpecialistSession } from "./specialist-session";
import { RouteError } from "@/core/errors";
import { ChartUnavailableError } from "@/core/tools/connector";
import { AuthError, cookieOptions, saveSession } from "./session";
import { launchCookie, readHandle, sessionCookie, storeHandle } from "./session-store";
import type { IdentityAdapter } from "./identity";
import { observeSmartLaunch, SmartLaunchFailure, type SmartLaunchReason } from "./smart-launch-failure";

const TOKEN_CLAIMS = ["iss", "sub", "aud", "exp", "iat", "nbf", "nonce", "fhirUser"];

const pendingSchema = z.object({ state: z.string(), verifier: z.string(), nonce: z.string(), issuer: z.string(), expiresAt: z.number() });
const mappingSchema = z.array(z.object({
  subject: z.string().min(1),
  fhirUser: z.string().min(1),
  clinicianId: z.uuid(),
  role: z.enum(["clinician", "physician"]),
})).min(1);

const MISSING_ENCOUNTER_MESSAGE = "Open a visit in the patient's chart, then launch StethoLink again.";

/**
 * Scopes sent on an EHR launch. `launch/patient` asks for standalone patient context; requested together
 * with `launch`, OpenEMR treats the launch as standalone and leaves the encounter out of the token, so
 * every launch from a chart failed. An EHR launch takes its patient and encounter from `launch` alone,
 * so the standalone scope is never sent, whatever `SMART_SCOPE` holds.
 */
export function ehrLaunchScope(configured: string) {
  return configured.split(/\s+/).filter((scope) => scope && scope !== "launch/patient").join(" ");
}

function registration() {
  const env = getEnv();
  if (env.AUTH_MODE !== "smart" || env.CLINICAL_DATA_SOURCE === "synthetic" ||
      !env.FHIR_BASE_URL || !env.SMART_CLIENT_ID || !env.SMART_AUTHORIZATION_URL || !env.SMART_TOKEN_URL ||
      !env.SMART_REDIRECT_URI || !env.SMART_SCOPE || !env.SMART_OIDC_ISSUER || !env.SMART_JWKS_URL || !env.SMART_CLINICIAN_MAP) {
    throw new SmartLaunchFailure("not_configured", undefined, new RouteError("not_implemented", "SMART launch is not configured"));
  }
  const invalid = (detail: string) => new SmartLaunchFailure("registration_invalid", detail, new RouteError("provider_unavailable", "SMART registration is invalid"));
  let mapping: z.infer<typeof mappingSchema>;
  try { mapping = mappingSchema.parse(JSON.parse(env.SMART_CLINICIAN_MAP)); }
  catch { throw invalid("clinician_map"); }
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
  if (new Set(reg.mapping.map((entry) => entry.subject)).size !== reg.mapping.length ||
      new Set(reg.mapping.map((entry) => entry.clinicianId)).size !== reg.mapping.length) throw invalid("clinician_map_duplicate");
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
        const specialist = specialistMap(getEnv()).find((entry) => entry.subject === payload.sub && entry.fhirUser === payload.fhirUser);
        // A clinician launch without a patient and an unregistered specialist look the same here.
        if (!specialist) throw new SmartLaunchFailure("missing_patient");
        return { specialist };
      }
      // The clinician is identified before anything about the visit is said to the browser.
      const mapped = reg.mapping.find((entry) => entry.subject === payload.sub && entry.fhirUser === payload.fhirUser);
      const root = reg.issuer.replace(/\/$/, "");
      if (!mapped) {
        // Which half of the pair did not match, and the form of the signed fhirUser. Neither value is logged.
        const signed = typeof payload.fhirUser === "string" ? payload.fhirUser : "";
        const form = signed.startsWith(root + "/") ? "absolute_on_issuer" : /^https?:\/\//i.test(signed) ? "absolute_elsewhere"
          : /^[A-Za-z]+\/[^/]+$/.test(signed) ? "relative" : "other";
        throw new SmartLaunchFailure("clinician_unmapped",
          reg.mapping.some((entry) => entry.subject === payload.sub) ? `fhir_user:${form}` : `subject:fhir_user_${form}`);
      }
      const reference = mapped.fhirUser.startsWith(root + "/") ? mapped.fhirUser.slice(root.length + 1) : mapped.fhirUser;
      const [type, id, extra] = reference.split("/");
      if (!["Practitioner", "PractitionerRole"].includes(type) || !id || !isFhirId(id) || extra !== undefined) {
        throw new SmartLaunchFailure("clinician_reference_invalid");
      }
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
        ehrUser: `${type}/${id}`,
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
  const unavailable = new RouteError("provider_unavailable", "SMART discovery could not be verified");
  const fail = (reason: SmartLaunchReason, detail?: string) => new SmartLaunchFailure(reason, detail, unavailable);
  let url: string;
  try {
    const issuer = secureEndpoint(reg.issuer);
    if (issuer.search) throw new Error("Invalid SMART FHIR base");
    url = issuer.href.replace(/\/$/, "") + "/.well-known/smart-configuration";
  } catch { throw fail("registration_invalid", "fhir_base"); }
  // Unreachable covers DNS, a certificate the server does not trust, a redirect and a timeout.
  const response = await fetch(url, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000) })
    .catch(() => { throw fail("discovery_unreachable"); });
  if (!response.ok) throw fail("discovery_rejected", `http:${response.status}`);
  const metadata = z.object({
    authorization_endpoint: z.url(), token_endpoint: z.url(), code_challenge_methods_supported: z.array(z.string()),
  }).safeParse(await response.json().catch(() => null));
  if (!metadata.success) throw fail("discovery_invalid");
  if (metadata.data.authorization_endpoint !== reg.authorizationEndpoint) throw fail("discovery_endpoint_mismatch", "endpoint:authorization");
  if (metadata.data.token_endpoint !== reg.tokenEndpoint) throw fail("discovery_endpoint_mismatch", "endpoint:token");
  if (!metadata.data.code_challenge_methods_supported.includes("S256")) throw fail("pkce_s256_unsupported");
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
