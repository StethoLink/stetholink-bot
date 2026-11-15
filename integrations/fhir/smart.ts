import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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
