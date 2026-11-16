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

interface OrderInput {
  request: string;
  chart: { facts: Array<{ id: string; category: string; status: string }> };
  catalog: { items: Array<{ id: string; display: string; synonyms: string[] }>; sets: Array<{ name: string; synonyms: string[]; itemIds: string[] }> };
}
/**
 * Deterministic "order model": it picks the catalog orders whose name the request contains, or the order set the request names, and
 * cites a documented chart fact for what it proposes. For a set it also names one order that the catalog does not hold, to show that the
 * product drops it. No inference.
 */
function fakeOrders(input: OrderInput) {
  const request = input.request.toLowerCase();
  const names = (entry: { display?: string; name?: string; synonyms: string[] }) => [entry.display ?? entry.name ?? "", ...entry.synonyms].filter(Boolean).map((name) => name.toLowerCase());
  const set = input.catalog.sets.find((entry) => names(entry).some((name) => request.includes(name)));
  const named = input.catalog.items.filter((item) => names(item).some((name) => request.includes(name)));
  const fact = input.chart.facts.find((entry) => entry.status === "known" && entry.category === "problem") ?? input.chart.facts.find((entry) => entry.status === "known");
  const evidenceIds = fact ? [fact.id] : [];
  if (set) return { mode: "case_based", items: [...set.itemIds.map((itemId) => ({ itemId, requestedText: "", reason: "Supported by the documented chart.", evidenceIds })),
    { itemId: "made-up-order", requestedText: "", reason: "Not in the catalog.", evidenceIds }], unmatched: [] };
  if (named.length) return { mode: "specific", items: named.map((item) => ({ itemId: item.id, requestedText: item.display, reason: "Requested by the physician.", evidenceIds: [] })), unmatched: [] };
  return { mode: "unclear", items: [], unmatched: [input.request] };
}

/** FICTIONAL visit that the fake transcription endpoint "hears", one part per call, whatever audio it is sent. The patient is called by name, another (fictional) doctor is named and a made-up phone number is spoken, as happens in a real visit. */
const FAKE_VISIT = [
  "هلا بك يا فيصل، كيف السكر معك هالفترة؟ والله يا دكتور القراءات الصبح بين مية وستين ومية وثمانين.",
  "عندك حساسية من أدوية؟ الشهر اللي فات أخذت مضاد حيوي فيه sulfa وطلع لي طفح جلدي قوي وحكة، والدكتور سلمان الحربي في الطوارئ قال لي عندك حساسية منه، ورقم جوالي 0550007788 لو احتجتوني.",
  "تاخذ metformin بانتظام؟ إيه، خمسمية ملي مرتين في اليوم مع الأكل.",
  "وآخر HbA1c كان ثمانية فاصلة واحد. بنعيد HbA1c بعد ثلاث شهور.",
];
interface ScribeInput { transcript: { segments: { id: string; text: string }[] }; chart: { facts: { id: string; category: string; label: string }[] } }
/** Deterministic "scribe model": lists each sentence with its own words as the quote, and proposes allergies and medicines named in Latin letters. */
function fakeScribeNote(input: ScribeInput) {
  const proposedUpdates: Record<string, string>[] = [];
  for (const segment of input.transcript.segments) {
    const term = /\b[A-Za-z][A-Za-z0-9-]{3,}\b/.exec(segment.text)?.[0];
    const kind = !term ? undefined : segment.text.includes("حساسي") ? "allergy" : /(?:^|\s)(?:آخذ|تاخذ)\s/.test(segment.text) ? "medication" : undefined;
    if (!term || !kind || proposedUpdates.some((update) => update.name.toLowerCase() === term.toLowerCase())) continue;
    const match = input.chart.facts.find((fact) => fact.category === kind && fact.label.toLowerCase().includes(term.toLowerCase()));
    proposedUpdates.push({ kind, name: term[0].toUpperCase() + term.slice(1), detail: "", relation: match ? "already_in_chart" : "new", chartFactId: match?.id ?? "", explanation: "", segmentId: segment.id, quote: segment.text });
  }
  return { subjective: input.transcript.segments.map((segment) => ({ text: segment.text, sources: [{ id: segment.id, quote: segment.text }] })),
    objective: [], assessment: [], plan: [], clinicianSegments: [], patientSegments: [], proposedUpdates };
}
const WRITABLE = ["DocumentReference", "AllergyIntolerance", "Condition", "MedicationStatement", "ServiceRequest", "MedicationRequest"];

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
    fhirRequests: [] as Array<{ method: string; path: string; ifNoneExist?: string }>,
    /** Resources the application created, by resource type. */
    created: [] as Array<Record<string, unknown> & { resourceType: string; id: string }>,
    transcriptionRequests: [] as Array<{ model: string; language: string; prompt: string; bytes: number }>,
    transcriptionCalls: 0,
    /** Resource types this EHR does not take a create for, as OpenEMR 7.0.3 takes neither ServiceRequest nor MedicationRequest. */
    noCreate: new Set<string>(),
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
      if (path === "/model/v1/audio/transcriptions" && req.method === "POST") {
        if (req.headers.authorization !== `Bearer ${options.modelKey}`) return json(res, 401, { error: "unauthorized" });
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const form = await new Response(Buffer.concat(chunks), { headers: { "content-type": req.headers["content-type"] ?? "" } }).formData();
        const file = form.get("file") as File;
        state.transcriptionRequests.push({ model: String(form.get("model")), language: String(form.get("language")), prompt: String(form.get("prompt") ?? ""), bytes: file.size });
        return json(res, 200, { text: FAKE_VISIT[state.transcriptionCalls++ % FAKE_VISIT.length] });
      }
      if (path === "/model/v1/responses" && req.method === "POST") {
        if (req.headers.authorization !== `Bearer ${options.modelKey}`) return json(res, 401, { error: "unauthorized" });
        const raw = await body(req);
        const request = JSON.parse(raw) as { input: Array<{ role: string; content: string }>; text: { format: { name: string } } };
        const task = request.text.format.name;
        state.modelRequests.push({ task, body: raw });
        const input = JSON.parse(request.input.at(-1)!.content);
        const text = JSON.stringify(task === "consultation_referral" ? fakeReferral(input) : task === "consultation_evidence_selection" ? { evidenceIds: input.eligibleEvidenceIds }
          : task === "scribe_soap_note" ? fakeScribeNote(input) : task === "order_drafting" ? fakeOrders(input) : {});
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
        const ifNoneExist = typeof req.headers["if-none-exist"] === "string" ? req.headers["if-none-exist"] : undefined;
        state.fhirRequests.push({ method: req.method ?? "GET", path: resource, ifNoneExist });
        if (resource === "/metadata") return json(res, 200, { resourceType: "CapabilityStatement", fhirVersion: "4.0.1",
          rest: [{ mode: "server", resource: WRITABLE.map((type) => ({ type, interaction: state.noCreate.has(type) ? [{ code: "read" }] : [{ code: "read" }, { code: "create" }], conditionalCreate: !state.noCreate.has(type) })) }] });
        if (req.method === "POST" && WRITABLE.includes(resource.slice(1)) && !state.noCreate.has(resource.slice(1))) {
          // Conditional create (FHIR R4): the identifier in If-None-Exist decides between 201 and 200.
          const incoming = JSON.parse(await body(req)) as Record<string, unknown> & { resourceType: string; identifier?: Array<{ system: string; value: string }> };
          if (incoming.resourceType !== resource.slice(1) || !ifNoneExist) return json(res, 400, { resourceType: "OperationOutcome" });
          const wanted = decodeURIComponent(new URLSearchParams(ifNoneExist).get("identifier") ?? "");
          const existing = state.created.find((entry) => entry.resourceType === incoming.resourceType && (entry.identifier as Array<{ system: string; value: string }> | undefined)?.some((id) => `${id.system}|${id.value}` === wanted));
          if (existing) return json(res, 200, existing);
          const stored = { ...incoming, id: `fic-created-${state.created.length + 1}` };
          state.created.push(stored);
          res.setHeader("location", `${origin}/fhir/${stored.resourceType}/${stored.id}/_history/1`);
          return json(res, 201, stored);
        }
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
