import { describe, expect, it } from "vitest";
import { formatPreflight, runSmartPreflight } from "@/integrations/fhir/smart-preflight";
import { clinicianReference, sameFhirUser } from "@/integrations/fhir/smart";
import { FAKE_EHR, smartEnv } from "../helpers/smart-launch";

const SUBJECT = "fictional-subject-never-printed";
const env = (change: Record<string, string | undefined> = {}) => ({
  ...smartEnv("physician"),
  SMART_CLINICIAN_MAP: JSON.stringify([{ subject: SUBJECT, fhirUser: FAKE_EHR.fhirUser, clinicianId: FAKE_EHR.clinicianId, role: "physician" }]),
  ...change,
});
const scopes = smartEnv("physician").SMART_SCOPE.split(" ");

/** A fictional EHR answering the four documents the preflight reads. `change` replaces one answer. */
function ehr(change: Record<string, unknown | (() => Response)> = {}) {
  const documents: Record<string, unknown> = {
    [FAKE_EHR.fhir + "/.well-known/smart-configuration"]: {
      authorization_endpoint: FAKE_EHR.oidc + "/authorize", token_endpoint: FAKE_EHR.oidc + "/token",
      code_challenge_methods_supported: ["S256"], capabilities: ["launch-ehr"], scopes_supported: scopes,
    },
    [FAKE_EHR.oidc + "/.well-known/openid-configuration"]: { issuer: FAKE_EHR.oidc, jwks_uri: FAKE_EHR.oidc + "/jwks", id_token_signing_alg_values_supported: ["RS256"] },
    [FAKE_EHR.oidc + "/jwks"]: { keys: [{ kty: "RSA", use: "sig", n: "fictional", e: "AQAB" }] },
    [FAKE_EHR.fhir + "/metadata"]: { resourceType: "CapabilityStatement", fhirVersion: "4.0.1" },
    ...change,
  };
  return (async (target: URL | string | Request) => {
    const answer = documents[String(target)];
    if (typeof answer === "function") return (answer as () => Response)();
    return answer === undefined ? new Response(null, { status: 404 }) : Response.json(answer);
  }) as typeof fetch;
}
const run = (settings = env(), request = ehr(), tlsCode?: string) =>
  runSmartPreflight(settings, { request, probeTls: async () => tlsCode, readFile: () => { throw new Error("no file"); } });
const failed = (checks: Awaited<ReturnType<typeof run>>) => checks.filter((check) => !check.ok).map((check) => check.name);
const detail = (checks: Awaited<ReturnType<typeof run>>, name: string) => checks.find((check) => check.name === name)!.detail;

describe("SMART preflight", () => {
  it("passes every check for a consistent registration and prints no value from the clinician map", async () => {
    const checks = await run();
    expect(failed(checks)).toEqual([]);
    expect(checks.map((check) => check.name)).toEqual(["settings", "endpoints", "scope", "clinician_map", "clinician_map_fhir_user", "ca_trust",
      "tls ehr.example.test", "tls id.example.test", "discovery", "pinned_endpoints", "pkce_s256", "ehr_launch", "scopes_supported", "oidc_issuer", "jwks", "fhir_api"]);
    const printed = formatPreflight(checks);
    expect(printed).toContain("All 16 checks passed");
    for (const secret of [SUBJECT, FAKE_EHR.fhirUser, FAKE_EHR.clinicianId]) expect(printed).not.toContain(secret);
  });

  it("names the empty settings and runs no discovery without them", async () => {
    const checks = await run(env({ SMART_TOKEN_URL: undefined, SMART_JWKS_URL: "", AUTH_MODE: "staging" }));
    expect(detail(checks, "settings")).toBe("AUTH_MODE must be smart; empty: SMART_TOKEN_URL, SMART_JWKS_URL");
    expect(detail(checks, "discovery")).toContain("not run");
    expect(formatPreflight(checks)).toMatch(/\d+ of \d+ checks failed/);
  });

  it("refuses endpoints that are not plain https, a FHIR base with a trailing slash and a wrong callback path", async () => {
    const checks = await run(env({ SMART_JWKS_URL: "http://id.example.test/jwks", FHIR_BASE_URL: FAKE_EHR.fhir + "/", SMART_REDIRECT_URI: FAKE_EHR.app + "/callback" }));
    expect(detail(checks, "endpoints")).toContain("not a plain https URL: SMART_JWKS_URL");
    expect(detail(checks, "endpoints")).toContain("FHIR_BASE_URL ends with a slash");
    expect(detail(checks, "endpoints")).toContain("/api/smart/callback");
  });

  it("checks the scope the launch sends", async () => {
    expect(detail(await run(env({ SMART_SCOPE: "launch patient/Patient.rs" })), "scope")).toBe("SMART_SCOPE lacks: openid, fhirUser");
    const withStandalone = await run(env({ SMART_SCOPE: "launch/patient " + smartEnv("physician").SMART_SCOPE }));
    expect(failed(withStandalone)).toEqual([]);
    expect(detail(withStandalone, "scope")).toContain("launch/patient is set and is never sent");
  });

  it.each([
    ["not JSON", "{", "clinician_map", "not a JSON list"],
    ["a role that does not exist", JSON.stringify([{ subject: SUBJECT, fhirUser: FAKE_EHR.fhirUser, clinicianId: FAKE_EHR.clinicianId, role: "admin" }]), "clinician_map", "not a JSON list"],
    ["a clinician ID that is not a UUID", JSON.stringify([{ subject: SUBJECT, fhirUser: FAKE_EHR.fhirUser, clinicianId: "1", role: "physician" }]), "clinician_map", "not a JSON list"],
    ["a duplicate subject", JSON.stringify([1, 2].map((n) => ({ subject: SUBJECT, fhirUser: FAKE_EHR.fhirUser, clinicianId: `55555555-5555-4555-8555-55555555555${n}`, role: "physician" }))), "clinician_map", "two entries"],
  ])("fails a clinician map with %s", async (_name, map, check, text) => {
    const checks = await run(env({ SMART_CLINICIAN_MAP: map }));
    expect(detail(checks, check)).toContain(text);
    expect(failed(checks)).toContain(check);
    expect(formatPreflight(checks)).not.toContain(SUBJECT);
  });

  it("checks every fhirUser against the issuer root and names the entry by position only", async () => {
    const entry = (n: number, fhirUser: string) => ({ subject: `${SUBJECT}-${n}`, fhirUser, clinicianId: `55555555-5555-4555-8555-55555555555${n}`, role: "physician" });
    const map = [entry(1, "Practitioner/a33befbc-75b6-4434-8ece-e0c1762888a0"), entry(2, `${FAKE_EHR.fhir}/Practitioner/fic-doctor`),
      entry(3, "https://other.example.test/fhir/Practitioner/fic-doctor"), entry(4, "fic-doctor"), entry(5, `${FAKE_EHR.fhir}/Person/fic-doctor`)];
    const good = await run(env({ SMART_CLINICIAN_MAP: JSON.stringify(map.slice(0, 2)) }));
    expect(failed(good)).toEqual([]);
    expect(detail(good, "clinician_map_fhir_user")).toContain("1 relative, 1 absolute");
    const bad = await run(env({ SMART_CLINICIAN_MAP: JSON.stringify(map) }));
    const text = detail(bad, "clinician_map_fhir_user");
    expect(text).toContain("entry 3: an absolute URL that is not on FHIR_BASE_URL");
    expect(text).toContain("entry 4: neither Practitioner/<id>");
    expect(text).toContain("entry 5: not a Practitioner or PractitionerRole reference");
    expect(text).not.toMatch(/entry [12]:/);
    expect(formatPreflight(bad)).not.toContain("other.example.test");
  });

  it("reports a certificate this process does not trust, with what to do", async () => {
    const checks = await run(env(), ehr(), "SELF_SIGNED_CERT_IN_CHAIN");
    expect(detail(checks, "tls ehr.example.test")).toBe("SELF_SIGNED_CERT_IN_CHAIN: the chain ends in a CA this process does not trust; add that CA to NODE_EXTRA_CA_CERTS");
    expect(failed(checks)).toEqual(["tls ehr.example.test", "tls id.example.test"]);
  });

  it("fails a NODE_EXTRA_CA_CERTS file Node would silently ignore", async () => {
    expect(detail(await run(env({ NODE_EXTRA_CA_CERTS: "/fictional/missing.pem" })), "ca_trust")).toContain("cannot be read");
    const empty = await runSmartPreflight(env({ NODE_EXTRA_CA_CERTS: "/fictional/empty.pem" }), { request: ehr(), probeTls: async () => undefined, readFile: () => "not a certificate" });
    expect(detail(empty, "ca_trust")).toBe("NODE_EXTRA_CA_CERTS holds no PEM certificate");
  });

  it.each([
    ["an unreachable discovery", { [FAKE_EHR.fhir + "/.well-known/smart-configuration"]: () => { throw new TypeError("fetch failed"); } }, "discovery", "discovery_unreachable"],
    ["a refused discovery", { [FAKE_EHR.fhir + "/.well-known/smart-configuration"]: () => new Response(null, { status: 500 }) }, "discovery", "discovery_rejected (http:500)"],
    ["another token endpoint", { [FAKE_EHR.fhir + "/.well-known/smart-configuration"]: { authorization_endpoint: FAKE_EHR.oidc + "/authorize", token_endpoint: FAKE_EHR.oidc + "/token2", code_challenge_methods_supported: ["S256"] } }, "pinned_endpoints", "another token endpoint than SMART_TOKEN_URL"],
    ["no PKCE S256", { [FAKE_EHR.fhir + "/.well-known/smart-configuration"]: { authorization_endpoint: FAKE_EHR.oidc + "/authorize", token_endpoint: FAKE_EHR.oidc + "/token", code_challenge_methods_supported: ["plain"] } }, "pkce_s256", "does not offer PKCE S256"],
    ["no EHR launch", { [FAKE_EHR.fhir + "/.well-known/smart-configuration"]: { authorization_endpoint: FAKE_EHR.oidc + "/authorize", token_endpoint: FAKE_EHR.oidc + "/token", code_challenge_methods_supported: ["S256"], capabilities: ["launch-standalone"] } }, "ehr_launch", "does not list launch-ehr"],
    ["another published issuer", { [FAKE_EHR.oidc + "/.well-known/openid-configuration"]: { issuer: FAKE_EHR.oidc + "/", jwks_uri: FAKE_EHR.oidc + "/jwks" } }, "oidc_issuer", "not exactly SMART_OIDC_ISSUER"],
    ["another published JWKS", { [FAKE_EHR.oidc + "/.well-known/openid-configuration"]: { issuer: FAKE_EHR.oidc, jwks_uri: FAKE_EHR.oidc + "/keys" } }, "oidc_issuer", "jwks_uri is not SMART_JWKS_URL"],
    ["an unreachable JWKS", { [FAKE_EHR.oidc + "/jwks"]: () => { throw new TypeError("fetch failed"); } }, "jwks", "could not be fetched"],
    ["a JWKS without a usable key", { [FAKE_EHR.oidc + "/jwks"]: { keys: [{ kty: "oct" }] } }, "jwks", "no RSA or P-256 signing key"],
    ["a FHIR API that is switched off", { [FAKE_EHR.fhir + "/metadata"]: () => new Response(null, { status: 404 }) }, "fhir_api", "answered HTTP 404"],
  ])("fails on %s", async (_name, change, check, text) => {
    const checks = await run(env(), ehr(change));
    expect(failed(checks)).toContain(check);
    expect(detail(checks, check)).toContain(text);
  });

  it("reads OpenEMR's scope list, which is wrapped in a second array, and names the scopes it does not list", async () => {
    const smart = (list: unknown) => ({ [FAKE_EHR.fhir + "/.well-known/smart-configuration"]: {
      authorization_endpoint: FAKE_EHR.oidc + "/authorize", token_endpoint: FAKE_EHR.oidc + "/token", code_challenge_methods_supported: ["S256"], scopes_supported: list } });
    expect(failed(await run(env(), ehr(smart([scopes]))))).toEqual([]);
    const v1 = scopes.map((scope) => scope.replace(/\.rs$/, ".read"));
    const checks = await run(env(), ehr(smart([v1])));
    expect(failed(checks)).toEqual(["scopes_supported"]);
    expect(detail(checks, "scopes_supported")).toContain("the EHR does not list: patient/Patient.rs patient/Encounter.rs");
  });
});

describe("clinician reference forms", () => {
  const base = "https://ehr.example.test/apis/default/fhir";
  const uuid = "a33befbc-75b6-4434-8ece-e0c1762888a0";
  it("reads the relative and the absolute form as the same clinician", () => {
    expect(clinicianReference(base, `Practitioner/${uuid}`)).toEqual({ form: "relative", reference: `Practitioner/${uuid}` });
    expect(clinicianReference(base, `${base}/Practitioner/${uuid}`)).toEqual({ form: "absolute_on_issuer", reference: `Practitioner/${uuid}` });
    expect(clinicianReference(base + "/", `${base}/PractitionerRole/role-1`)).toEqual({ form: "absolute_on_issuer", reference: "PractitionerRole/role-1" });
    expect(sameFhirUser(base, `${base}/Practitioner/${uuid}`, `Practitioner/${uuid}`)).toBe(true);
    expect(sameFhirUser(base, `Practitioner/${uuid}`, `${base}/Practitioner/${uuid}`)).toBe(true);
  });
  it("resolves nothing outside the pinned base or outside a clinician resource", () => {
    for (const value of [`https://ehr.example.test/apis/other/fhir/Practitioner/${uuid}`, `${base}.example/Practitioner/${uuid}`, `${base}/Patient/${uuid}`,
      `${base}/Practitioner/${uuid}/_history/1`, `${base}/Practitioner/`, `Practitioner/../${uuid}`, `javascript:Practitioner/${uuid}`, "", 7, null, undefined, { a: 1 }]) {
      expect(clinicianReference(base, value).reference).toBeUndefined();
      expect(sameFhirUser(base, value, `Practitioner/${uuid}`)).toBe(false);
    }
    expect(clinicianReference(base, `${base}/Person/${uuid}`)).toEqual({ form: "absolute_on_issuer", person: true });
    expect(sameFhirUser(base, `Practitioner/${uuid}`, `Practitioner/${uuid.toUpperCase()}`)).toBe(false);
  });
});
