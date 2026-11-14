import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import https from "node:https";
import { fictionalFhirResponse, FICTIONAL_ENCOUNTER_ID, FICTIONAL_PATIENT_ID } from "../../fixtures/fhir-chart.ts";

/**
 * FICTIONAL EHR for end-to-end tests, in one HTTPS server:
 *   /fhir/...   FHIR R4 server holding one invented patient (reads, searches, discovery)
 *   /oidc/...   SMART / OpenID Connect issuer that signs real ID tokens (ES256) and serves its JWKS
 *   /model/...  stand-in for the model's Responses API: restates each chart fact with its citation
 * No real hospital, clinician, patient or model is involved.
 */
export interface FakeEhrOptions {
  port: number;
  tls: { key: Buffer; cert: Buffer };
  clientId: string;
  redirectUri: string;
  modelKey: string;
  /** Who is signing in, by OIDC subject. */
  users: Record<string, { fhirUser: string }>;
}

const b64 = (value: Buffer | string) => Buffer.from(value).toString("base64url");
const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

interface AuthoringInput {
  physicianRequest: string;
  availableSpecialties: string[];
  chart: { facts: Array<{ id: string; category: string; label: string; status: string; value?: string | number | boolean; unit?: string | null }>; citableFactIds: string[] };
  revision?: { specialty: string; clinicalQuestion: string };
}
const SECTION: Record<string, string> = {
  problem: "relevantHistory", history: "relevantHistory", symptom: "presentingSymptoms", vital_sign: "examinationFindings",
  investigation: "investigations", medication: "currentMedications", allergy: "clinicalContext",
};
/** Deterministic "model": every citable fact is restated in its section with its id. No inference. */
function fakeReferral(input: AuthoringInput) {
  const request = input.physicianRequest.toLowerCase();
  const sections: Record<string, Array<{ text: string; evidenceIds: string[] }>> = {
    relevantHistory: [], presentingSymptoms: [], examinationFindings: [], investigations: [], currentMedications: [], clinicalContext: [],
  };
  const citable = new Set(input.chart.citableFactIds);
  for (const fact of input.chart.facts) {
    if (fact.status !== "known" || !citable.has(fact.id)) continue;
    const value = typeof fact.value === "boolean" ? "" : `: ${String(fact.value)}${fact.unit ? ` ${fact.unit}` : ""}`;
    sections[SECTION[fact.category] ?? "clinicalContext"].push({ text: `${fact.label}${value}`, evidenceIds: [fact.id] });
  }
  return {
    specialty: input.revision?.specialty ?? input.availableSpecialties.find((name) => request.includes(name.toLowerCase())) ?? (/cardiology/.test(request) ? "Cardiology" : ""),
    clinicalQuestion: input.revision?.clinicalQuestion ?? input.physicianRequest.trim(),
    sections,
    missingInformation: input.chart.facts.filter((fact) => fact.status === "unknown").map((fact) => ({ evidenceId: fact.id })),
    suggestedAdditionalInformation: [],
    requestReview: { verdict: "proceed", concerns: [] },
  };
}

export async function startFakeEhr(options: FakeEhrOptions) {
  const origin = `https://localhost:${options.port}`;
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "fictional-key-1", alg: "ES256", use: "sig" };
  const codes = new Map<string, { subject: string; nonce: string; challenge: string; patient: string; encounter?: string }>();
  const tokens = new Set<string>();
  const state = {
    /** The user who "signs in" at the next authorization request. */
    currentUser: Object.keys(options.users)[0],
    /** Launch context handed out at the next authorization; a standalone launch has no patient. */
    context: { patient: FICTIONAL_PATIENT_ID as string | undefined, encounter: FICTIONAL_ENCOUNTER_ID as string | undefined },
    modelRequests: [] as Array<{ task: string; body: string }>,
    fhirRequests: [] as Array<{ method: string; path: string }>,
    /** Replace one FHIR answer, e.g. to return an unsupported encounter. */
    fhirOverride: undefined as undefined | ((path: string, query: URLSearchParams) => unknown),
  };

  function idToken(subject: string, nonce: string, accessToken: string) {
    const now = Math.floor(Date.now() / 1000);
    const header = b64(JSON.stringify({ alg: "ES256", kid: jwk.kid, typ: "JWT" }));
    const payload = b64(JSON.stringify({
      iss: `${origin}/oidc`, aud: options.clientId, sub: subject, iat: now, exp: now + 300, nonce, fhirUser: options.users[subject].fhirUser,
      at_hash: b64(createHash("sha256").update(accessToken).digest().subarray(0, 16)),
    }));
    return `${header}.${payload}.${b64(sign("sha256", Buffer.from(`${header}.${payload}`), { key: privateKey, dsaEncoding: "ieee-p1363" }))}`;
  }

  async function body(req: import("node:http").IncomingMessage) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }

  const server = https.createServer(options.tls, async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", origin);
      const path = url.pathname;
      if (path === "/oidc/jwks") return json(res, 200, { keys: [jwk] });
      if (path === "/oidc/authorize") {
        // The EHR has already authenticated its user; it returns a single-use code to the registered redirect URI.
        const q = url.searchParams;
        if (q.get("client_id") !== options.clientId || q.get("redirect_uri") !== options.redirectUri || q.get("code_challenge_method") !== "S256" || !q.get("launch")) return json(res, 400, { error: "invalid_request" });
        const code = randomUUID();
        codes.set(code, { subject: state.currentUser, nonce: q.get("nonce") ?? "", challenge: q.get("code_challenge") ?? "", patient: state.context.patient ?? "", encounter: state.context.encounter });
        res.writeHead(302, { location: `${options.redirectUri}?${new URLSearchParams({ code, state: q.get("state") ?? "" })}` });
        return res.end();
      }
      if (path === "/oidc/token" && req.method === "POST") {
        const form = new URLSearchParams(await body(req));
        const grant = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        if (!grant || form.get("client_id") !== options.clientId || form.get("redirect_uri") !== options.redirectUri ||
            b64(createHash("sha256").update(form.get("code_verifier") ?? "").digest()) !== grant.challenge) return json(res, 400, { error: "invalid_grant" });
        const accessToken = `fictional-${randomUUID()}`;
        tokens.add(accessToken);
        return json(res, 200, {
          token_type: "Bearer", access_token: accessToken, expires_in: 900, id_token: idToken(grant.subject, grant.nonce, accessToken),
          scope: process.env.SMART_SCOPE ?? "launch openid fhirUser", ...(grant.patient ? { patient: grant.patient } : {}), ...(grant.encounter ? { encounter: grant.encounter } : {}),
        });
      }
      if (path === "/model/v1/responses" && req.method === "POST") {
        if (req.headers.authorization !== `Bearer ${options.modelKey}`) return json(res, 401, { error: "unauthorized" });
        const raw = await body(req);
        const request = JSON.parse(raw) as { input: Array<{ role: string; content: string }>; text: { format: { name: string } } };
        const task = request.text.format.name;
        state.modelRequests.push({ task, body: raw });
        const input = JSON.parse(request.input.at(-1)!.content);
        const text = JSON.stringify(task === "consultation_referral" ? fakeReferral(input) : task === "consultation_evidence_selection" ? { evidenceIds: input.eligibleEvidenceIds } : {});
        return json(res, 200, {
          status: "completed", model: "fictional-model-1", usage: { input_tokens: Math.ceil(raw.length / 4), output_tokens: Math.ceil(text.length / 4) },
          output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] }],
        });
      }
      if (path.startsWith("/fhir/")) {
        const resource = path.slice("/fhir".length);
        if (resource === "/.well-known/smart-configuration") return json(res, 200, {
          authorization_endpoint: `${origin}/oidc/authorize`, token_endpoint: `${origin}/oidc/token`, code_challenge_methods_supported: ["S256"],
          capabilities: ["launch-ehr", "launch-standalone", "client-public", "context-ehr-patient", "context-ehr-encounter", "sso-openid-connect", "permission-v2"],
        });
        if (!tokens.has((req.headers.authorization ?? "").replace(/^Bearer /, ""))) return json(res, 401, { resourceType: "OperationOutcome" });
        state.fhirRequests.push({ method: req.method ?? "GET", path: resource });
        if (req.method !== "GET") return json(res, 405, { resourceType: "OperationOutcome" });
        const answer = state.fhirOverride?.(resource, url.searchParams) ?? fictionalFhirResponse(resource, url.searchParams);
        return answer === undefined ? json(res, 404, { resourceType: "OperationOutcome" }) : json(res, 200, answer);
      }
      return json(res, 404, { error: "not_found" });
    } catch {
      return json(res, 500, { error: "fake_ehr_failure" });
    }
  });
  await new Promise<void>((resolve) => server.listen(options.port, "127.0.0.1", resolve));
  return { origin, fhirBase: `${origin}/fhir`, oidcIssuer: `${origin}/oidc`, modelBase: `${origin}/model/v1`, state, close: () => new Promise((resolve) => server.close(resolve)) };
}
