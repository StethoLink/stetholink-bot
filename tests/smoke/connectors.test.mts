import assert from "node:assert/strict";
import { test } from "node:test";
import { createFhirConnector } from "../../integrations/fhir/connector.ts";
import { createOpenEmrConnector } from "../../integrations/openemr/connector.ts";
import { beginSmartLaunch, exchangeSmartCode } from "../../integrations/fhir/smart.ts";

const registration = {
  issuer: "https://ehr.example/fhir",
  authorizationEndpoint: "https://ehr.example/authorize",
  tokenEndpoint: "https://ehr.example/token",
  redirectUri: "https://app.example/callback",
  clientId: "test-client",
  scope: "launch patient/Patient.r",
};

test("SMART launch binds the registered issuer and callback to PKCE", async () => {
  assert.throws(() => beginSmartLaunch(registration, "https://untrusted.example", "launch"));
  const { authorizationUrl, pending } = beginSmartLaunch(registration, registration.issuer, "launch");
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorizationUrl.searchParams.get("aud"), registration.issuer);
  assert.notEqual(authorizationUrl.searchParams.get("code_challenge"), pending.verifier);
  let calls = 0;
  const request: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), registration.tokenEndpoint);
    assert.equal(init?.redirect, "error");
    assert.equal((init?.body as URLSearchParams).get("code_verifier"), pending.verifier);
    return Response.json({ token_type: "Bearer", access_token: "synthetic-token", patient: "a", expires_in: 600 });
  };
  await assert.rejects(exchangeSmartCode(registration, pending, { code: "code", state: "wrong" }, request));
  assert.equal(calls, 0);
  const result = await exchangeSmartCode(registration, pending, { code: "code", state: pending.state }, request);
  assert.equal(result.grant.patientId, "a");
  assert.equal(calls, 1);
});

for (const factory of [createFhirConnector, createOpenEmrConnector]) {
  test(`${factory.name} keeps requests inside the authorized patient context`, async () => {
    const paths: string[] = [];
    const request: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-token");
      assert.equal(init?.redirect, "error");
      if (path.endsWith("/Patient/a")) return Response.json({ resourceType: "Patient", id: "a", name: [{ text: "Synthetic" }] });
      if (path.endsWith("/Encounter/e")) return Response.json({ resourceType: "Encounter", id: "e", subject: { reference: "Patient/b" } });
      return Response.json({ resourceType: "Bundle", entry: [] });
    };
    const connector = factory({ baseUrl: registration.issuer, accessToken: "synthetic-token", patientId: "a", encounterId: "e" }, request);
    assert.equal(await connector.getPatient("b"), null);
    assert.equal(await connector.getEncounter("other"), null);
    assert.deepEqual(paths, []);
    assert.equal((await connector.getPatient("a"))?.displayName, "Synthetic");
    assert.equal(await connector.getEncounter("e"), null);
    assert.equal(paths.length, 5);
  });
}
