import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { isFhirId, type FhirLaunchGrant } from "./connector.ts";

export interface SmartRegistration {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  redirectUri: string;
  scope: string;
}

/** Why a code exchange failed. A stable code for the server log: it names the step, never a value. */
export type SmartExchangeReason = "callback_invalid" | "token_endpoint_unreachable" | "token_exchange_rejected" | "grant_invalid";

export class SmartExchangeError extends Error {
  readonly reason: SmartExchangeReason;
  /** HTTP status of the token endpoint's refusal, when there was one. */
  readonly status?: number;
  constructor(reason: SmartExchangeReason, message: string, status?: number) {
    super(message);
    this.name = "SmartExchangeError";
    this.reason = reason;
    this.status = status;
  }
}

export function secureEndpoint(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("SMART endpoints must use trusted HTTPS URLs");
  }
  return url;
}

/**
 * Scopes sent on an EHR launch. `launch/patient` asks for standalone patient context; requested together
 * with `launch`, OpenEMR treats the launch as standalone and leaves the encounter out of the token, so
 * every launch from a chart failed. An EHR launch takes its patient and encounter from `launch` alone,
 * so the standalone scope is never sent, whatever `SMART_SCOPE` holds.
 */
export function ehrLaunchScope(configured: string) {
  return configured.split(/\s+/).filter((scope) => scope && scope !== "launch/patient").join(" ");
}

/** The form of a `fhirUser` value, for the log and the preflight. It never carries the value itself. */
export type FhirUserForm = "relative" | "absolute_on_issuer" | "absolute_elsewhere" | "other";

/**
 * Reads a `fhirUser` as a clinician on the pinned FHIR base. EHRs sign it either relative
 * (`Practitioner/<id>`) or absolute (`<FHIR base>/Practitioner/<id>`; OpenEMR signs this form, with a
 * UUID id). Both name the same resource, so both resolve to the same `reference`. An absolute URL is
 * accepted only when it sits directly on the pinned base, compared as an exact prefix: a `fhirUser` on
 * another host, port, path or scheme never resolves, so a clinician of another server cannot match.
 */
export function clinicianReference(fhirBase: string, fhirUser: unknown): { form: FhirUserForm; reference?: string; person?: true } {
  if (typeof fhirUser !== "string" || !fhirUser) return { form: "other" };
  const root = fhirBase.replace(/\/+$/, "");
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(fhirUser);
  const form: FhirUserForm = fhirUser.startsWith(root + "/") ? "absolute_on_issuer" : absolute ? "absolute_elsewhere"
    : /^[A-Za-z]+\/[^/]+$/.test(fhirUser) ? "relative" : "other";
  if (form !== "relative" && form !== "absolute_on_issuer") return { form };
  const [type, id, extra] = (form === "relative" ? fhirUser : fhirUser.slice(root.length + 1)).split("/");
  if (!id || !isFhirId(id) || extra !== undefined) return { form };
  // OpenEMR signs `Person/<id>` for a user who has no NPI: to the EHR that user is not a practitioner.
  if (type === "Person") return { form, person: true };
  if (type !== "Practitioner" && type !== "PractitionerRole") return { form };
  return { form, reference: `${type}/${id}` };
}

/**
 * Whether a signed `fhirUser` is the mapped one: the same string, or the same clinician resource on the
 * pinned FHIR base written in the other form. Resource type and id are compared exactly (ids are case-sensitive).
 */
export function sameFhirUser(fhirBase: string, signed: unknown, mapped: string) {
  if (signed === mapped) return true;
  const reference = clinicianReference(fhirBase, signed).reference;
  return reference !== undefined && reference === clinicianReference(fhirBase, mapped).reference;
}

export const clinicianMapSchema = z.array(z.object({
  subject: z.string().min(1),
  fhirUser: z.string().min(1),
  clinicianId: z.uuid(),
  role: z.enum(["clinician", "physician"]),
})).min(1);
export type ClinicianMap = z.infer<typeof clinicianMapSchema>;

/** Reads `SMART_CLINICIAN_MAP`. The problem is a fixed word, never a value from the map. */
export function parseClinicianMap(json: string): { mapping: ClinicianMap } | { problem: "clinician_map" | "clinician_map_duplicate" } {
  let mapping: ClinicianMap;
  try { mapping = clinicianMapSchema.parse(JSON.parse(json)); }
  catch { return { problem: "clinician_map" }; }
  if (new Set(mapping.map((entry) => entry.subject)).size !== mapping.length ||
      new Set(mapping.map((entry) => entry.clinicianId)).size !== mapping.length) return { problem: "clinician_map_duplicate" };
  return { mapping };
}

export type SmartDiscoveryReason = "registration_invalid" | "discovery_unreachable" | "discovery_rejected" | "discovery_invalid"
  | "discovery_endpoint_mismatch" | "pkce_s256_unsupported";

export class SmartDiscoveryError extends Error {
  readonly reason: SmartDiscoveryReason;
  readonly detail?: string;
  constructor(reason: SmartDiscoveryReason, detail?: string) {
    super(reason);
    this.name = "SmartDiscoveryError";
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Fetches the EHR's SMART configuration and checks it against the pinned registration: the published
 * authorization and token endpoints must be exactly the configured ones, and PKCE S256 must be offered.
 * The launch runs this on every request and the admin preflight runs the same code.
 */
export async function checkSmartDiscovery(registration: SmartRegistration, request: typeof fetch = fetch) {
  let url: string;
  try {
    const issuer = secureEndpoint(registration.issuer);
    if (issuer.search) throw new Error("Invalid SMART FHIR base");
    url = issuer.href.replace(/\/$/, "") + "/.well-known/smart-configuration";
  } catch { throw new SmartDiscoveryError("registration_invalid", "fhir_base"); }
  // Unreachable covers DNS, a certificate the server does not trust, a redirect and a timeout.
  const response = await request(url, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000) })
    .catch(() => { throw new SmartDiscoveryError("discovery_unreachable"); });
  if (!response.ok) {
    await response.body?.cancel();
    throw new SmartDiscoveryError("discovery_rejected", `http:${response.status}`);
  }
  const metadata = z.object({
    authorization_endpoint: z.url(), token_endpoint: z.url(), code_challenge_methods_supported: z.array(z.string()),
    capabilities: z.array(z.string()).optional(),
    // OpenEMR 7.0.3 publishes the scope list wrapped in a second array.
    scopes_supported: z.array(z.union([z.string(), z.array(z.string())])).optional(),
  }).safeParse(await response.json().catch(() => null));
  if (!metadata.success) throw new SmartDiscoveryError("discovery_invalid");
  if (metadata.data.authorization_endpoint !== registration.authorizationEndpoint) throw new SmartDiscoveryError("discovery_endpoint_mismatch", "endpoint:authorization");
  if (metadata.data.token_endpoint !== registration.tokenEndpoint) throw new SmartDiscoveryError("discovery_endpoint_mismatch", "endpoint:token");
  if (!metadata.data.code_challenge_methods_supported.includes("S256")) throw new SmartDiscoveryError("pkce_s256_unsupported");
  return { capabilities: metadata.data.capabilities, scopesSupported: metadata.data.scopes_supported?.flat() };
}

export function beginSmartLaunch(registration: SmartRegistration, issuer: string, launch: string) {
  if (issuer !== registration.issuer || !launch || launch.length > 4096) {
    throw new Error("Unregistered SMART launch");
  }
  secureEndpoint(registration.issuer);
  secureEndpoint(registration.tokenEndpoint);
  secureEndpoint(registration.redirectUri);
  const authorizationUrl = secureEndpoint(registration.authorizationEndpoint);
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  for (const [key, value] of Object.entries({
    response_type: "code", client_id: registration.clientId, redirect_uri: registration.redirectUri,
    launch, scope: registration.scope, state, nonce, aud: registration.issuer,
    code_challenge: challenge, code_challenge_method: "S256",
  })) authorizationUrl.searchParams.set(key, value);
  return {
    authorizationUrl,
    pending: { state, verifier, nonce, issuer, expiresAt: Date.now() + 5 * 60_000 },
  };
}

type PendingLaunch = ReturnType<typeof beginSmartLaunch>["pending"];

// The caller must consume the pending launch once from its browser-bound session store.
export async function exchangeSmartCode(
  registration: SmartRegistration,
  pending: PendingLaunch,
  callback: { state: string; code: string },
  request: typeof fetch = fetch,
): Promise<{ grant: FhirLaunchGrant; expiresAt: number; idToken?: string; scope?: string; hasPatient: boolean }> {
  const expected = Buffer.from(pending.state);
  const actual = Buffer.from(callback.state);
  if (!callback.code || pending.issuer !== registration.issuer || pending.expiresAt <= Date.now() ||
      expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new SmartExchangeError("callback_invalid", "Invalid or expired SMART callback");
  }
  const response = await request(secureEndpoint(registration.tokenEndpoint), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code: callback.code, client_id: registration.clientId,
      redirect_uri: registration.redirectUri, code_verifier: pending.verifier,
    }),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
    // Unreachable covers DNS, TLS trust, a redirect and a timeout: the server never got an answer it could use.
  }).catch(() => { throw new SmartExchangeError("token_endpoint_unreachable", "SMART token endpoint could not be reached"); });
  if (!response.ok) {
    await response.body?.cancel();
    throw new SmartExchangeError("token_exchange_rejected", "SMART authorization exchange failed", response.status);
  }
  const token = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!token || typeof token !== "object" || typeof token.token_type !== "string" || token.token_type.toLowerCase() !== "bearer" ||
      typeof token.access_token !== "string" || !token.access_token ||
      // A launch outside a chart (a specialist opening the inbox) carries no patient; with one, it must be well formed.
      (token.patient !== undefined && (typeof token.patient !== "string" || !isFhirId(token.patient))) ||
      typeof token.expires_in !== "number" || !Number.isSafeInteger(token.expires_in) ||
      token.expires_in <= 0 || token.expires_in > 86400 ||
      (token.encounter !== undefined && (typeof token.encounter !== "string" || !isFhirId(token.encounter)))) {
    throw new SmartExchangeError("grant_invalid", "SMART authorization did not return a usable grant");
  }
  return {
    grant: {
      baseUrl: registration.issuer, accessToken: token.access_token,
      patientId: typeof token.patient === "string" ? token.patient : "", encounterId: token.encounter,
    },
    hasPatient: typeof token.patient === "string",
    expiresAt: Date.now() + token.expires_in * 1000,
    idToken: typeof token.id_token === "string" ? token.id_token : undefined,
    scope: typeof token.scope === "string" ? token.scope : undefined,
  };
}
