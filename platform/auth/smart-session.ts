import "server-only";
import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { beginSmartLaunch, exchangeSmartCode, secureEndpoint, type SmartRegistration } from "@/integrations/fhir/smart";
import { createFhirConnector, isFhirId } from "@/integrations/fhir/connector";
import { getEnv } from "@/platform/tenants/env";
import { RouteError } from "@/core/errors";
import { AuthError, cookieOptions, saveSession } from "./session";
import { launchCookie, readHandle, sessionCookie, storeHandle } from "./session-store";
import type { IdentityAdapter } from "./identity";

const pendingSchema = z.object({ state: z.string(), verifier: z.string(), nonce: z.string(), issuer: z.string(), expiresAt: z.number() });
const mappingSchema = z.array(z.object({
  subject: z.string().min(1),
  fhirUser: z.string().min(1),
  clinicianId: z.uuid(),
  role: z.enum(["clinician", "physician"]),
})).min(1);

function registration() {
  const env = getEnv();
  if (env.AUTH_MODE !== "smart" || env.CLINICAL_DATA_SOURCE === "synthetic" ||
      !env.FHIR_BASE_URL || !env.SMART_CLIENT_ID || !env.SMART_AUTHORIZATION_URL || !env.SMART_TOKEN_URL ||
      !env.SMART_REDIRECT_URI || !env.SMART_SCOPE || !env.SMART_OIDC_ISSUER || !env.SMART_JWKS_URL || !env.SMART_CLINICIAN_MAP) {
    throw new RouteError("not_implemented", "SMART launch is not configured");
  }
  const reg = {
    issuer: env.FHIR_BASE_URL, authorizationEndpoint: env.SMART_AUTHORIZATION_URL, tokenEndpoint: env.SMART_TOKEN_URL,
    clientId: env.SMART_CLIENT_ID, redirectUri: env.SMART_REDIRECT_URI, scope: env.SMART_SCOPE,
    oidcIssuer: env.SMART_OIDC_ISSUER, jwksUrl: env.SMART_JWKS_URL,
    // A verified SMART session is live only for a tenant configured for live clinical data.
    tenantId: env.TENANT_ID, dataClassification: env.CLINICAL_DATA_MODE, mapping: mappingSchema.parse(JSON.parse(env.SMART_CLINICIAN_MAP)),
  };
  secureEndpoint(reg.oidcIssuer);
  secureEndpoint(reg.jwksUrl);
  if (new Set(reg.mapping.map((entry) => entry.subject)).size !== reg.mapping.length ||
      new Set(reg.mapping.map((entry) => entry.clinicianId)).size !== reg.mapping.length ||
      !["launch", "openid", "fhirUser"].every((scope) => reg.scope.split(/\s+/).includes(scope))) {
    throw new RouteError("provider_unavailable", "SMART registration is invalid");
  }
  return reg;
}

type Registration = ReturnType<typeof registration>;
type Callback = { state: string; code: string };

function smartIdentityAdapter(reg: Registration): IdentityAdapter<{ pending: z.infer<typeof pendingSchema>; callback: Callback }> {
  return {
    async verify({ pending, callback }) {
      const result = await exchangeSmartCode(reg, pending, callback);
      if (!result.idToken || !result.scope || !result.grant.encounterId) throw new Error("Required SMART launch claims missing");
      const scopes = result.scope.split(/\s+/).filter(Boolean);
      if (!scopes.includes("openid") || !scopes.includes("fhirUser")) throw new Error("SMART identity scopes missing");

      const { payload } = await jwtVerify(result.idToken, createRemoteJWKSet(secureEndpoint(reg.jwksUrl), { timeoutDuration: 5000 }), {
        algorithms: ["RS256", "ES256"], issuer: reg.oidcIssuer, audience: reg.clientId,
        requiredClaims: ["iss", "sub", "aud", "exp", "iat", "nonce", "fhirUser"], maxTokenAge: "5m",
      });
      if (payload.nonce !== pending.nonce ||
          (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== reg.clientId) ||
          (payload.azp !== undefined && payload.azp !== reg.clientId)) throw new Error("SMART identity binding failed");

      if (payload.at_hash !== undefined) {
        const hash = createHash("sha256").update(result.grant.accessToken).digest().subarray(0, 16).toString("base64url");
        if (payload.at_hash !== hash) throw new Error("SMART access token binding failed");
      }

      const mapped = reg.mapping.find((entry) => entry.subject === payload.sub && entry.fhirUser === payload.fhirUser);
      const root = reg.issuer.replace(/\/$/, "");
      const reference = mapped?.fhirUser.startsWith(root + "/") ? mapped.fhirUser.slice(root.length + 1) : mapped?.fhirUser;
      const [type, id, extra] = reference?.split("/") ?? [];
      if (!mapped || !["Practitioner", "PractitionerRole"].includes(type) || !id || !isFhirId(id) || extra !== undefined) {
        throw new Error("SMART clinician is not authorized");
      }

      const adapter = createFhirConnector(result.grant);
      const [patient, encounter] = await Promise.all([
        adapter.getPatient(result.grant.patientId), adapter.getEncounter(result.grant.encounterId),
      ]);
      if (!patient || !encounter) throw new Error("SMART chart context could not be verified");
      const expiresAt = Math.min(result.expiresAt, payload.exp! * 1000, Date.now() + 15 * 60_000);
      return {
        source: "smart",
        ehrAccessToken: result.grant.accessToken,
        context: {
          clinicianId: mapped.clinicianId, tenantId: reg.tenantId, roles: [mapped.role],
          scopes: ["chart:read", ...scopes.map((scope) => "smart:" + scope)], patientId: patient.patientId, encounterId: encounter.encounterId,
          expiresAt, authorization: "active", dataClassification: reg.dataClassification,
        },
      };
    },
  };
}

async function discover(reg: SmartRegistration) {
  const issuer = secureEndpoint(reg.issuer);
  if (issuer.search) throw new Error("Invalid SMART FHIR base");
  const url = issuer.href.replace(/\/$/, "") + "/.well-known/smart-configuration";
  const response = await fetch(url, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("SMART discovery unavailable");
  const metadata = z.object({
    authorization_endpoint: z.url(), token_endpoint: z.url(), code_challenge_methods_supported: z.array(z.string()),
  }).parse(await response.json());
  if (metadata.authorization_endpoint !== reg.authorizationEndpoint || metadata.token_endpoint !== reg.tokenEndpoint ||
      !metadata.code_challenge_methods_supported.includes("S256")) throw new Error("Unexpected SMART discovery metadata");
}

export async function openSmartLaunch(issuer: string, launch: string) {
  const reg = registration();
  if (issuer !== reg.issuer || !launch || launch.length > 4096) throw new AuthError("forbidden", "Unregistered SMART launch");
  try { await discover(reg); }
  catch { throw new RouteError("provider_unavailable", "SMART discovery could not be verified"); }
  const { authorizationUrl, pending } = beginSmartLaunch(reg, issuer, launch);
  const jar = await cookies();
  await readHandle(jar.get(launchCookie)?.value, "launch", true);
  await readHandle(jar.get(sessionCookie)?.value, "session", true);
  jar.set(sessionCookie, "", cookieOptions(0));
  jar.set(launchCookie, await storeHandle("launch", pending, pending.expiresAt), cookieOptions(300));
  return authorizationUrl;
}

export async function finishSmartLaunch(callback: Callback) {
  const reg = registration();
  const jar = await cookies();
  const pending = pendingSchema.safeParse(await readHandle(jar.get(launchCookie)?.value, "launch", true));
  jar.set(launchCookie, "", cookieOptions(0));
  if (!pending.success) throw new AuthError("forbidden", "SMART launch session is missing or expired");
  const verified = await smartIdentityAdapter(reg).verify({ pending: pending.data, callback }).catch(() => {
    throw new AuthError("forbidden", "SMART clinician or chart context could not be verified");
  });
  if (verified.context.expiresAt <= Date.now()) throw new AuthError("forbidden", "SMART grant expired");
  await saveSession(verified);
}
