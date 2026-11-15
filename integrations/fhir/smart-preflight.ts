import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect } from "node:tls";
import {
  checkSmartDiscovery, clinicianReference, ehrLaunchScope, parseClinicianMap, secureEndpoint, SmartDiscoveryError,
} from "./smart.ts";

/**
 * Admin preflight for a SMART registration: everything the launch needs that can be checked without a
 * clinician signing in. It runs the same discovery and mapping code as the launch. It never prints a
 * value from `SMART_CLINICIAN_MAP` (entries are named by position) and handles no token.
 */
export interface PreflightCheck { name: string; ok: boolean; detail: string }

export interface PreflightDeps {
  request?: typeof fetch;
  /** Opens a TLS connection with the trust the server process uses. Resolves with an error code, or undefined when trusted. */
  probeTls?: (url: URL) => Promise<string | undefined>;
  readFile?: (path: string) => string;
}

const REQUIRED = ["FHIR_BASE_URL", "SMART_CLIENT_ID", "SMART_AUTHORIZATION_URL", "SMART_TOKEN_URL", "SMART_REDIRECT_URI",
  "SMART_OIDC_ISSUER", "SMART_JWKS_URL", "SMART_SCOPE", "SMART_CLINICIAN_MAP"] as const;
const ENDPOINTS = ["FHIR_BASE_URL", "SMART_AUTHORIZATION_URL", "SMART_TOKEN_URL", "SMART_REDIRECT_URI", "SMART_OIDC_ISSUER", "SMART_JWKS_URL"] as const;
/** Hosts the server calls itself. The redirect URI and the authorization endpoint are opened by the browser only. */
const SERVER_CALLED = ["FHIR_BASE_URL", "SMART_TOKEN_URL", "SMART_OIDC_ISSUER", "SMART_JWKS_URL"] as const;

const TLS_HINTS: Record<string, string> = {
  SELF_SIGNED_CERT_IN_CHAIN: "the chain ends in a CA this process does not trust; add that CA to NODE_EXTRA_CA_CERTS",
  DEPTH_ZERO_SELF_SIGNED_CERT: "the certificate is self-signed; add it to NODE_EXTRA_CA_CERTS",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "the issuing CA is unknown or the server does not send its intermediate; add the CA to NODE_EXTRA_CA_CERTS",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "the issuing CA is unknown; add it to NODE_EXTRA_CA_CERTS",
  ERR_TLS_CERT_ALTNAME_INVALID: "the certificate is not for this host name; use the name the certificate was issued for",
  CERT_HAS_EXPIRED: "the certificate has expired",
  ECONNREFUSED: "nothing listens on this host and port",
  ENOTFOUND: "the host name does not resolve from this machine",
  ETIMEDOUT: "no answer within 5 seconds",
};

export function probeTlsWithNodeTrust(url: URL): Promise<string | undefined> {
  return new Promise((resolve) => {
    const socket = connect({ host: url.hostname, port: Number(url.port || 443), servername: url.hostname, timeout: 5000 });
    const done = (code?: string) => { socket.destroy(); resolve(code); };
    socket.once("secureConnect", () => done());
    socket.once("timeout", () => done("ETIMEDOUT"));
    socket.once("error", (error: NodeJS.ErrnoException) => done(error.code ?? "TLS_ERROR"));
  });
}

async function getJson(request: typeof fetch, url: string) {
  try {
    const response = await request(url, { redirect: "error", cache: "no-store", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      await response.body?.cancel();
      return { problem: `answered HTTP ${response.status}` };
    }
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    return body && typeof body === "object" ? { body } : { problem: "did not answer with JSON" };
  } catch {
    return { problem: "could not be fetched (DNS, certificate trust, a redirect or a timeout)" };
  }
}

export async function runSmartPreflight(env: Record<string, string | undefined>, deps: PreflightDeps = {}): Promise<PreflightCheck[]> {
  const request = deps.request ?? fetch;
  const probeTls = deps.probeTls ?? probeTlsWithNodeTrust;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const checks: PreflightCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => { checks.push({ name, ok, detail }); return ok; };
  const skip = (name: string, why: string) => add(name, false, `not run: ${why}`);

  // 1. Settings.
  const missing = REQUIRED.filter((key) => !env[key]);
  const mode = env.AUTH_MODE === "smart" ? [] : ["AUTH_MODE must be smart"];
  const configured = add("settings", !missing.length && !mode.length,
    missing.length || mode.length ? [...mode, ...(missing.length ? [`empty: ${missing.join(", ")}`] : [])].join("; ") : "AUTH_MODE=smart and every SMART setting is present");

  // 2. Endpoint form.
  const badEndpoints = ENDPOINTS.filter((key) => {
    if (!env[key]) return false;
    try { secureEndpoint(env[key]); return false; } catch { return true; }
  });
  const fhirBase = env.FHIR_BASE_URL ?? "";
  const baseProblems = [
    ...(badEndpoints.length ? [`not a plain https URL: ${badEndpoints.join(", ")}`] : []),
    ...(/[?#]/.test(fhirBase) ? ["FHIR_BASE_URL has a query or fragment"] : []),
    ...(fhirBase.endsWith("/") ? ["FHIR_BASE_URL ends with a slash; the EHR sends its base without one as iss, and the two must be equal"] : []),
    ...(env.SMART_REDIRECT_URI && !env.SMART_REDIRECT_URI.endsWith("/api/smart/callback") ? ["SMART_REDIRECT_URI must end with /api/smart/callback"] : []),
  ];
  const endpointsOk = add("endpoints", !baseProblems.length, baseProblems.join("; ") || "every endpoint is https, without credentials or fragment");

  // 3. Scope.
  const requested = ehrLaunchScope(env.SMART_SCOPE ?? "").split(/\s+/).filter(Boolean);
  const lacking = ["launch", "openid", "fhirUser"].filter((scope) => !requested.includes(scope));
  add("scope", !lacking.length, lacking.length ? `SMART_SCOPE lacks: ${lacking.join(", ")}`
    : "has launch, openid and fhirUser" + (/(^|\s)launch\/patient(\s|$)/.test(env.SMART_SCOPE ?? "") ? " (launch/patient is set and is never sent)" : ""));

  // 4. Clinician map.
  const parsed = env.SMART_CLINICIAN_MAP ? parseClinicianMap(env.SMART_CLINICIAN_MAP) : undefined;
  if (!parsed) skip("clinician_map", "SMART_CLINICIAN_MAP is empty");
  else if ("problem" in parsed) {
    add("clinician_map", false, parsed.problem === "clinician_map"
      ? "not a JSON list of { subject, fhirUser, clinicianId (UUID), role (clinician or physician) }"
      : "a subject or a clinicianId appears in two entries");
  } else add("clinician_map", true, `${parsed.mapping.length} well-formed ${parsed.mapping.length === 1 ? "entry" : "entries"}`);

  // 5. fhirUser form against the issuer root.
  if (!parsed || "problem" in parsed || !fhirBase) skip("clinician_map_fhir_user", "needs a valid clinician map and FHIR_BASE_URL");
  else {
    const forms = parsed.mapping.map((entry) => clinicianReference(fhirBase, entry.fhirUser));
    const bad = forms.flatMap((form, index) => form.reference ? [] : [`entry ${index + 1}: ${
      form.form === "absolute_elsewhere" ? "an absolute URL that is not on FHIR_BASE_URL (compare scheme, host, port and path)"
        : form.form === "other" ? "neither Practitioner/<id> nor <FHIR_BASE_URL>/Practitioner/<id>"
        : "not a Practitioner or PractitionerRole reference with a valid id"}`]);
    const count = (form: string) => forms.filter((entry) => entry.form === form).length;
    add("clinician_map_fhir_user", !bad.length, bad.join("; ")
      || `every fhirUser names a clinician on FHIR_BASE_URL (${count("relative")} relative, ${count("absolute_on_issuer")} absolute); both forms match what the EHR signs`);
  }

  // 6. The CA trust of this process. Node reads NODE_EXTRA_CA_CERTS once, at start, and ignores a bad file silently.
  const caFile = env.NODE_EXTRA_CA_CERTS;
  if (!caFile) add("ca_trust", true, "NODE_EXTRA_CA_CERTS is not set: only Node's built-in public CAs are trusted");
  else {
    try {
      const blocks = readFile(caFile).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
      const expired = blocks.filter((pem) => new Date(new X509Certificate(pem).validTo).getTime() <= Date.now()).length;
      add("ca_trust", blocks.length > 0 && !expired, !blocks.length ? "NODE_EXTRA_CA_CERTS holds no PEM certificate"
        : expired ? `NODE_EXTRA_CA_CERTS holds ${expired} expired certificate(s)` : `NODE_EXTRA_CA_CERTS holds ${blocks.length} certificate(s), none expired`);
    } catch {
      add("ca_trust", false, "NODE_EXTRA_CA_CERTS cannot be read as PEM certificates; Node would ignore it without an error");
    }
  }

  // 7. A TLS handshake to every host the server calls, with this process's trust.
  const origins = new Map<string, URL>();
  for (const key of SERVER_CALLED) {
    try { const url = secureEndpoint(env[key] ?? ""); origins.set(url.host, url); } catch { /* reported by the endpoints check */ }
  }
  if (!origins.size) skip("tls", "no usable server endpoint");
  for (const [host, url] of origins) {
    const code = await probeTls(url);
    add(`tls ${host}`, !code, code ? `${code}: ${TLS_HINTS[code] ?? "the TLS connection failed"}` : "certificate trusted by this process");
  }

  // 8 to 11. SMART discovery, with the launch's own check.
  if (!configured || !endpointsOk) {
    for (const name of ["discovery", "pinned_endpoints", "pkce_s256", "ehr_launch", "scopes_supported"]) skip(name, "fix the settings and endpoints first");
  } else {
    const discovered = await checkSmartDiscovery({
      issuer: fhirBase, authorizationEndpoint: env.SMART_AUTHORIZATION_URL!, tokenEndpoint: env.SMART_TOKEN_URL!,
      clientId: env.SMART_CLIENT_ID!, redirectUri: env.SMART_REDIRECT_URI!, scope: requested.join(" "),
    }, request).catch((error: unknown) => error instanceof SmartDiscoveryError ? error : new SmartDiscoveryError("discovery_unreachable"));
    const failed = discovered instanceof SmartDiscoveryError ? discovered : undefined;
    const before = (reasons: string[]) => failed !== undefined && reasons.includes(failed.reason);
    const unreadable = before(["registration_invalid", "discovery_unreachable", "discovery_rejected", "discovery_invalid"]);
    add("discovery", !unreadable, unreadable ? `${failed!.reason}${failed!.detail ? ` (${failed!.detail})` : ""}: <FHIR_BASE_URL>/.well-known/smart-configuration did not give a usable document`
      : "<FHIR_BASE_URL>/.well-known/smart-configuration answers");
    if (unreadable) for (const name of ["pinned_endpoints", "pkce_s256", "ehr_launch", "scopes_supported"]) skip(name, "discovery failed");
    else {
      const mismatch = before(["discovery_endpoint_mismatch"]);
      add("pinned_endpoints", !mismatch, mismatch
        ? `the EHR publishes another ${failed!.detail === "endpoint:token" ? "token endpoint than SMART_TOKEN_URL" : "authorization endpoint than SMART_AUTHORIZATION_URL"}`
        : "SMART_AUTHORIZATION_URL and SMART_TOKEN_URL equal the published endpoints");
      if (mismatch) skip("pkce_s256", "fix the pinned endpoints first");
      else add("pkce_s256", !failed, failed ? "the EHR does not offer PKCE S256" : "the EHR offers PKCE S256");
      if (failed) for (const name of ["ehr_launch", "scopes_supported"]) skip(name, "fix the checks above first");
      else {
        const { capabilities, scopesSupported } = discovered as Exclude<typeof discovered, SmartDiscoveryError>;
        add("ehr_launch", !capabilities || capabilities.includes("launch-ehr"),
          !capabilities ? "the EHR publishes no capability list" : capabilities.includes("launch-ehr") ? "the EHR lists launch-ehr" : "the EHR does not list launch-ehr");
        const unsupported = scopesSupported ? requested.filter((scope) => !scopesSupported.includes(scope)) : [];
        add("scopes_supported", !unsupported.length, unsupported.length
          ? `the EHR does not list: ${unsupported.join(" ")} (OpenEMR refuses a registration or an authorization that asks for an unlisted scope)`
          : scopesSupported ? "the EHR lists every scope in SMART_SCOPE" : "the EHR publishes no scope list");
      }
    }
  }

  // 12. OpenID configuration of the pinned issuer.
  let oidcOk = false;
  try { secureEndpoint(env.SMART_OIDC_ISSUER ?? ""); oidcOk = true; } catch { skip("oidc_issuer", "SMART_OIDC_ISSUER is not usable"); }
  if (oidcOk) {
    const oidc = await getJson(request, env.SMART_OIDC_ISSUER!.replace(/\/$/, "") + "/.well-known/openid-configuration");
    if (!oidc.body) add("oidc_issuer", false, `<SMART_OIDC_ISSUER>/.well-known/openid-configuration ${oidc.problem}`);
    else {
      const algorithms = Array.isArray(oidc.body.id_token_signing_alg_values_supported) ? oidc.body.id_token_signing_alg_values_supported : undefined;
      const problems = [
        ...(oidc.body.issuer !== env.SMART_OIDC_ISSUER ? ["the published issuer is not exactly SMART_OIDC_ISSUER (ID tokens would fail with claim:iss)"] : []),
        ...(oidc.body.jwks_uri !== env.SMART_JWKS_URL ? ["the published jwks_uri is not SMART_JWKS_URL"] : []),
        ...(algorithms && !algorithms.some((alg) => alg === "RS256" || alg === "ES256") ? ["ID tokens are signed with neither RS256 nor ES256"] : []),
      ];
      add("oidc_issuer", !problems.length, problems.join("; ") || "the published issuer and jwks_uri equal SMART_OIDC_ISSUER and SMART_JWKS_URL");
    }
  }

  // 13. Signing keys.
  let jwksOk = false;
  try { secureEndpoint(env.SMART_JWKS_URL ?? ""); jwksOk = true; } catch { skip("jwks", "SMART_JWKS_URL is not usable"); }
  if (jwksOk) {
    const jwks = await getJson(request, env.SMART_JWKS_URL!);
    const keys = Array.isArray(jwks.body?.keys) ? jwks.body.keys as Array<Record<string, unknown>> : [];
    const usable = keys.filter((key) => (key.kty === "RSA" || (key.kty === "EC" && key.crv === "P-256")) && (key.use === undefined || key.use === "sig"));
    add("jwks", usable.length > 0, !jwks.body ? `SMART_JWKS_URL ${jwks.problem}` : usable.length ? `${usable.length} signing key(s) for RS256 or ES256`
      : "SMART_JWKS_URL holds no RSA or P-256 signing key");
  }

  // 14. The FHIR API itself.
  if (!fhirBase || badEndpoints.includes("FHIR_BASE_URL")) skip("fhir_api", "FHIR_BASE_URL is not usable");
  else {
    const metadata = await getJson(request, fhirBase.replace(/\/$/, "") + "/metadata");
    const version = typeof metadata.body?.fhirVersion === "string" ? metadata.body.fhirVersion : undefined;
    add("fhir_api", metadata.body?.resourceType === "CapabilityStatement" && !!version?.startsWith("4."),
      !metadata.body ? `<FHIR_BASE_URL>/metadata ${metadata.problem}` : version?.startsWith("4.") ? `FHIR ${version} capability statement answers`
        : "<FHIR_BASE_URL>/metadata is not an R4 capability statement");
  }
  return checks;
}

export function formatPreflight(checks: PreflightCheck[]) {
  const failed = checks.filter((check) => !check.ok).length;
  return [
    ...checks.map((check) => `${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}`),
    "",
    failed ? `${failed} of ${checks.length} checks failed. Fix them before asking a clinician to sign in.`
      : `All ${checks.length} checks passed. What only a real launch can show: the client is enabled in the EHR, the signed subject and fhirUser are in SMART_CLINICIAN_MAP, a visit is open in the chart, and the EHR lets the clinician read it.`,
  ].join("\n");
}
