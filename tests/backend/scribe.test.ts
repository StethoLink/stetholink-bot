import { describe, expect, it, vi } from "vitest";
import type { ClinicianContext } from "@/core/auth/clinician";
import { mockProvider } from "@/core/agent/providers/mock-provider";
import { clinicalSafetyGuard } from "@/core/agent/safety/guard";
import { statedNumbers } from "@/core/scribe/numbers";
import { buildNoteInput, renderNoteText, validateNote, type NoteContext } from "@/core/scribe/note";
import { toSentences } from "@/core/scribe/segments";
import { createScribeService, type ScribeConfig } from "@/core/scribe/service";
import type { ChartWriteLedger, ScribeRepository, StoredChartWrite, StoredScribeSession } from "@/core/scribe/repository";
import type { ChartWriteItem, ClinicalWriteAdapter } from "@/core/tools/chart-writer";
import { createFhirWriter, grantsCreate } from "@/integrations/fhir/writer";
import { createOpenAITranscription } from "@/integrations/transcription/openai";
import { mockTranscription } from "@/integrations/transcription/mock";
import { liveModeProblems, parseEnv } from "@/platform/tenants/env";
import type { ClinicalFact, ScribeNote, TranscriptSegment } from "@/shared/contracts";

/** Every visit, patient and identifier here is fictional. */
const segment = (index: number, text: string): TranscriptSegment => ({ id: `s${index}`, speaker: null, startMs: 0, endMs: 1000, text });
const fact = (id: string, category: ClinicalFact["category"], label: string, value: string | boolean = true): ClinicalFact =>
  ({ id, category, label, status: "known", value, source: { type: "synthetic", reference: "fictional-chart" }, timestamp: "2026-01-01T00:00:00.000Z" });
const segments = [
  segment(1, "عندك حساسية من أي دواء؟"),
  segment(2, "لا، ما عندي حساسية من شي."),
  segment(3, "آخذ amlodipine خمسة ملي مرة في اليوم للضغط."),
  segment(4, "قست لك الضغط الحين مية وخمسين على خمسة وتسعين، والنبض ثمانية وثمانين."),
  segment(5, "بنسوي لك ECG و troponin الحين، وأشتبه في stable angina بس ما نقدر نأكد قبل الفحوصات."),
];
const facts = [fact("allergy-1", "allergy", "Penicillin", "Reaction: Urticaria (severe)"), fact("medication-1", "medication", "Amlodipine 5 mg oral tablet", "5 mg once daily")];
const context: NoteContext = { segments, facts, demographics: { age: "54 years", sex: "male" }, noteLanguage: "en", spokenLanguage: "ar-SA" };
const statement = (text: string, id: string, quote: string) => ({ text, sources: [{ id, quote }] });
const output = (change: Record<string, unknown> = {}) => JSON.stringify({
  subjective: [statement("Denies drug allergies.", "s2", "ما عندي حساسية من شي"), statement("Takes amlodipine 5 mg once daily.", "s3", "آخذ amlodipine خمسة ملي مرة في اليوم")],
  objective: [statement("Blood pressure 150/95 mmHg, pulse 88.", "s4", "الضغط الحين مية وخمسين على خمسة وتسعين، والنبض ثمانية وثمانين")],
  assessment: [statement("Clinician suspects stable angina; cannot be confirmed before the tests.", "s5", "وأشتبه في stable angina بس ما نقدر نأكد قبل الفحوصات")],
  plan: [statement("ECG and troponin now.", "s5", "بنسوي لك ECG و troponin الحين")],
  clinicianSegments: ["s1", "s4", "s5"], patientSegments: ["s2", "s3"],
  proposedUpdates: [
    { kind: "allergy", name: "Patient states no drug allergies", detail: "", relation: "conflicts", chartFactId: "allergy-1", explanation: "The patient denies drug allergies; the chart records penicillin.", segmentId: "s2", quote: "ما عندي حساسية من شي" },
    { kind: "medication", name: "Amlodipine", detail: "5 mg once daily", relation: "new", chartFactId: "", explanation: "", segmentId: "s3", quote: "آخذ amlodipine خمسة ملي مرة في اليوم" },
  ],
  ...change,
});

describe("spoken Arabic numbers", () => {
  it.each([
    ["مية وخمسين على خمسة وتسعين", ["150", "95"]], ["ثمانية فاصلة واحد", ["8.1"]], ["خمسمية ملي مرتين في اليوم", ["500", "2"]], ["ألف ملي", ["1000"]],
    ["ثمانية وثلاثين", ["38"]], ["١٥٠ على ٩٥", ["150", "95"]], ["130/80", ["130", "80"]], ["ثلاث أيام", ["3"]], ["خمسة وسبعين ميكروجرام", ["75"]],
  ])("%s", (text, expected) => {
    for (const number of expected) expect(statedNumbers(text), text).toContain(number);
  });
  it("does not find a number that was not said", () => {
    expect(statedNumbers("خمسة وتسعين")).not.toContain("5");
    expect(statedNumbers("آخذ الدواء كل يوم")).toEqual(new Set());
  });
});

describe("scribe note validation", () => {
  it("keeps statements whose quote is in the cited segment and whose figures were said", () => {
    const note = validateNote(output(), context);
    expect(note.rejectedStatements).toBe(0);
    expect(note.sections.objective[0]).toMatchObject({ id: "o1", sources: [{ kind: "transcript", id: "s4" }] });
    expect(note.speakers.get("s5")).toBe("clinician");
    expect(renderNoteText(note.sections, "en")).toContain("Assessment:\n- Clinician suspects stable angina");
  });
  it("removes a statement with an invented dose, a quote that was not said, an unknown source or no source", () => {
    const note = validateNote(output({ subjective: [
      statement("Takes amlodipine 10 mg once daily.", "s3", "آخذ amlodipine خمسة ملي مرة في اليوم"),
      statement("Has chest pain radiating to the jaw.", "s3", "ألم في الصدر يمتد للفك"),
      statement("Smokes.", "s99", "أدخن"),
      { text: "No fever.", sources: [] },
      statement("Denies drug allergies.", "s2", "ما عندي حساسية من شي"),
    ] }), context);
    expect(note.sections.subjective.map((entry) => entry.text)).toEqual(["Denies drug allergies."]);
    expect(note.rejectedStatements).toBe(4);
  });
  it("accepts assessment and plan only in the clinician's own words", () => {
    const note = validateNote(output({
      assessment: [statement("Likely unstable angina.", "s2", "ما عندي حساسية من شي")],
      plan: [{ text: "Continue amlodipine.", sources: [{ id: "medication-1", quote: "" }] }, statement("ECG and troponin now.", "s5", "بنسوي لك ECG و troponin الحين")],
    }), context);
    expect(note.sections.assessment).toEqual([]);
    expect(note.sections.plan.map((entry) => entry.text)).toEqual(["ECG and troponin now."]);
  });
  it("refuses a response that is mostly unsupported, and unsafe text", () => {
    const invented = Array.from({ length: 4 }, (_, index) => statement(`Invented finding ${index}.`, "s1", "كلام لم يقال"));
    expect(() => validateNote(output({ subjective: invented, objective: [], assessment: [], plan: [] }), context)).toThrow(expect.objectContaining({ code: "safety_blocked" }));
    expect(() => validateNote("not json", context)).toThrow(expect.objectContaining({ code: "provider_unavailable" }));
    const note = validateNote(output({ subjective: [statement("Denies <b>allergies</b>.", "s2", "ما عندي حساسية من شي"), statement("Denies drug allergies.", "s2", "ما عندي حساسية من شي")] }), context);
    expect(note.sections.subjective).toHaveLength(1);
  });
  it("classifies proposed items against the chart and never trusts 'new' for something documented", () => {
    const note = validateNote(output(), context);
    expect(note.proposedUpdates).toEqual([
      expect.objectContaining({ id: "u1", kind: "allergy", relation: "conflicts", chartFactId: "allergy-1", explanation: expect.stringContaining("penicillin") }),
      // The model said "new"; the chart already documents amlodipine.
      expect.objectContaining({ id: "u2", kind: "medication", name: "Amlodipine", relation: "already_in_chart", chartFactId: "medication-1" }),
    ]);
  });
  it("drops a proposed item with an unsaid quote, an invented figure or a chart fact of another kind", () => {
    const base = { kind: "medication", name: "Aspirin", detail: "81 mg daily", relation: "new", chartFactId: "", explanation: "", segmentId: "s3", quote: "آخذ amlodipine خمسة ملي مرة في اليوم" };
    const note = validateNote(output({ proposedUpdates: [base, { ...base, name: "Ibuprofen", detail: "", quote: "آخذ ibuprofen" }, { ...base, name: "Metformin", detail: "", relation: "already_in_chart", chartFactId: "allergy-1" }] }), context);
    expect(note.proposedUpdates).toEqual([]);
    expect(note.rejectedUpdates).toBe(3);
  });
  it("sends the model the transcript, chart facts, age and sex, and nothing that identifies the patient", () => {
    const sent = JSON.parse(buildNoteInput(context));
    expect(Object.keys(sent).sort()).toEqual(["chart", "noteLanguage", "patient", "spokenLanguage", "transcript"]);
    expect(sent.patient).toEqual({ age: "54 years", sex: "male" });
    expect(JSON.stringify(sent)).not.toContain("fictional-chart");
  });
  it("splits recognized speech into sentences without changing a word", () => {
    const text = "هلا بك. كيف السكر معك؟ والله يا دكتور القراءات عالية.";
    const sentences = toSentences([{ startMs: 0, endMs: 9000, text }]);
    expect(sentences.map((sentence) => sentence.text).join(" ")).toBe(text);
    expect(sentences.length).toBe(2);
    expect(sentences[1].startMs).toBeGreaterThan(0);
  });
});

function memory() {
  const state: { session?: StoredScribeSession; segments: TranscriptSegment[]; chunks: Set<number>; writes: Map<string, StoredChartWrite>; approvals: number } = { segments: [], chunks: new Set(), writes: new Map(), approvals: 0 };
  const repository: ScribeRepository = {
    async start(input) {
      return state.session ??= { id: input.id, status: "recording", consentConfirmedAt: new Date().toISOString(), spokenLanguage: input.spokenLanguage, noteLanguage: input.noteLanguage, note: null, noteVersion: 0,
        approval: null, audioSeconds: 0, spendUsd: 0, transcriptExpiresAt: input.transcriptExpiresAt.toISOString(), transcriptDeleted: false, createdAt: new Date().toISOString() };
    },
    async get(id) { return state.session?.id === id ? { session: { ...state.session }, segments: [...state.segments], writes: [...state.writes.values()] } : null; },
    async list() { return []; },
    async addChunk(_id, index, sentences, seconds, cost) {
      if (state.chunks.has(index)) return { added: false };
      state.chunks.add(index);
      for (const sentence of sentences) state.segments.push({ id: `s${state.segments.length + 1}`, speaker: null, ...sentence });
      state.session!.audioSeconds += seconds; state.session!.spendUsd += cost;
      return { added: true };
    },
    async stop() { if (state.session!.status === "recording") state.session!.status = "transcribed"; },
    async saveNote(_id, note, _speakers, cost) { Object.assign(state.session!, { note, status: "note_ready", noteVersion: state.session!.noteVersion + 1, spendUsd: state.session!.spendUsd + cost }); return state.session!; },
    async editNote(_id, version, note) { if (version !== state.session!.noteVersion) throw new Error("conflict"); Object.assign(state.session!, { note, noteVersion: version + 1 }); return state.session!; },
    async relabel() {},
    async approve(_id, version, selection) { state.approvals++; Object.assign(state.session!, { status: "approved", approval: { noteVersion: version, selection }, approvedAt: new Date().toISOString() }); return state.session!; },
    async discard() { state.session!.status = "discarded"; state.segments = []; },
    async finish(_id, outcome) { if (outcome.noteInChart) { state.session!.status = "written"; state.session!.transcriptDeleted = true; state.segments = []; } },
  };
  const ledger: ChartWriteLedger = {
    async begin(_origin, _originId, itemKey, resourceType) { const row = state.writes.get(itemKey) ?? { itemKey, resourceType, status: "pending" as const }; state.writes.set(itemKey, row); return row; },
    async record(itemKey, status, resourceId, failure) { const row = state.writes.get(itemKey)!; if (!["created", "existing"].includes(row.status)) Object.assign(row, { status, resourceId, failure }); },
    async forOrigin() { return [...state.writes.values()]; },
  };
  return { state, repository, ledger };
}
const actor = (change: Partial<ClinicianContext> = {}): ClinicianContext => ({
  clinicianId: "55555555-5555-4555-8555-555555555555", tenantId: "fictional", roles: ["physician"], scopes: ["chart:read", "scribe:record", "chart:write"],
  patientId: "syn-pt-001", encounterId: "syn-enc-001", expiresAt: Date.now() + 60_000, authorization: "active", dataClassification: "synthetic", ...change,
});
const config: ScribeConfig = { enabled: true, spokenLanguage: "ar-SA", noteLanguage: "en", maxVisitMinutes: 2, maxVisitUsd: 0.5, transcriptRetentionDays: 7, chunkSeconds: 25 };
const adapter = { source: "synthetic" as const, async getPatient(id: string) { return { patientId: id, displayName: "Fictional Patient", sex: "male" as const, allergies: [], activeProblems: [], medications: [], source: "synthetic" as const, clinicalFacts: facts }; }, async getEncounter() { return null; } };
const audio = new Uint8Array(500);
const chunk = (index: number, durationMs = 25_000) => ({ index, durationMs, mimeType: "audio/webm;codecs=opus", audio });
const ID = "9f6b7c1e-1c1f-4c58-9a57-0d7f6f0d1a11";

function service(options: { writer?: ClinicalWriteAdapter | null; config?: Partial<ScribeConfig> } = {}) {
  const store = memory();
  const scribe = createScribeService({ repository: store.repository, ledger: store.ledger, transcription: mockTranscription, noteProvider: mockProvider, safety: clinicalSafetyGuard, adapter,
    writer: options.writer ?? null, dataClassification: "synthetic", config: { ...config, ...options.config } });
  return { ...store, scribe };
}
async function recorded(options: Parameters<typeof service>[0] = {}) {
  const made = service(options);
  await made.scribe.start(actor(), { patientConsentConfirmed: true, idempotencyKey: ID });
  for (const index of [0, 1, 2, 3]) await made.scribe.addChunk(actor(), ID, chunk(index));
  const view = await made.scribe.generateNote(actor(), ID);
  return { ...made, view };
}

describe("scribe service", () => {
  it("does not start without the consent statement, a scribe permission or when switched off", async () => {
    const { scribe, state } = service();
    await expect(scribe.start(actor(), { patientConsentConfirmed: false as never, idempotencyKey: ID })).rejects.toMatchObject({ code: "forbidden" });
    await expect(scribe.start(actor({ scopes: ["chart:read"] }), { patientConsentConfirmed: true, idempotencyKey: ID })).rejects.toMatchObject({ code: "forbidden" });
    await expect(scribe.start(actor({ dataClassification: "live" }), { patientConsentConfirmed: true, idempotencyKey: ID })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service({ config: { enabled: false } }).scribe.start(actor(), { patientConsentConfirmed: true, idempotencyKey: ID })).rejects.toMatchObject({ code: "not_implemented" });
    expect(state.session).toBeUndefined();
  });
  it("stores each part once, refuses oversize or non-audio parts and stops at the visit limit", async () => {
    const { scribe, state } = service();
    await scribe.start(actor(), { patientConsentConfirmed: true, idempotencyKey: ID });
    expect(await scribe.addChunk(actor(), ID, chunk(0))).toMatchObject({ added: true });
    expect(await scribe.addChunk(actor(), ID, chunk(0))).toMatchObject({ added: false });
    await expect(scribe.addChunk(actor(), ID, { ...chunk(1), mimeType: "text/plain" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(scribe.addChunk(actor(), ID, { ...chunk(1), audio: new Uint8Array(2_000_001) })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(scribe.addChunk(actor(), ID, chunk(1, 61_000))).rejects.toMatchObject({ code: "invalid_request" });
    for (const index of [1, 2, 3]) await scribe.addChunk(actor(), ID, chunk(index));
    // 2 minutes is the configured limit for this test: 100 s are recorded, a fifth part would exceed it.
    await expect(scribe.addChunk(actor(), ID, chunk(4))).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("2 minutes") });
    expect(state.session?.audioSeconds).toBe(100);
  });
  it("drafts a note that awaits the physician; a non-physician cannot approve it", async () => {
    const { scribe, view, state } = await recorded();
    expect(view.status).toBe("note_ready");
    expect(view.note?.provenance).toMatchObject({ liveInference: false, dataClassification: "synthetic" });
    expect(view.note?.proposedUpdates.find((update) => update.name === "Sulfa")).toMatchObject({ kind: "allergy", relation: "new" });
    const selection = { note: true, updates: [] };
    await expect(scribe.approveAndWrite(actor({ roles: ["clinician"] }), ID, { expectedVersion: 1, selection })).rejects.toMatchObject({ code: "forbidden" });
    await expect(scribe.approveAndWrite(actor({ scopes: ["chart:read", "scribe:record"] }), ID, { expectedVersion: 1, selection })).rejects.toMatchObject({ code: "forbidden" });
    expect(state.approvals).toBe(0);
  });
  it("writes only what the physician selected, once, and deletes the transcript when the note is in the chart", async () => {
    const created: ChartWriteItem[] = [];
    const writer: ClinicalWriteAdapter = { source: "fhir", create: vi.fn(async (item) => { created.push(item); return { status: "created" as const, resourceType: "DocumentReference" as const, resourceId: `fic-${created.length}` }; }) };
    const { scribe, view, state } = await recorded({ writer });
    const sulfa = view.note!.proposedUpdates.find((update) => update.name === "Sulfa")!.id;
    const input = { expectedVersion: 1, selection: { note: true, updates: [sulfa], confirmedAllergies: [] } };
    const written = await scribe.approveAndWrite(actor(), ID, input);
    expect(created.map((item) => item.kind)).toEqual(["document", "allergy"]);
    expect(created[1]).toMatchObject({ substance: "Sulfa", confirmedByPhysician: false });
    expect(created.every((item) => item.itemKey.startsWith("sl-9f6b7c1e1c1f4c589a570d7f6f0d1a11-"))).toBe(true);
    expect(written).toMatchObject({ status: "written", transcriptDeleted: true, segments: [] });
    expect(written.writes.map((write) => write.status)).toEqual(["created", "created"]);
    // Repeating the approval resumes: nothing is created a second time.
    await scribe.approveAndWrite(actor(), ID, input);
    expect(writer.create).toHaveBeenCalledTimes(2);
    expect(state.session?.status).toBe("written");
  });
  it("never writes a conflicting or already documented item, and falls back to copy text without a writer", async () => {
    const { scribe, state, view } = await recorded();
    state.session!.note = { ...state.session!.note!, proposedUpdates: [{ ...view.note!.proposedUpdates[0], id: "u1", relation: "conflicts" }] } as ScribeNote;
    await expect(scribe.approveAndWrite(actor(), ID, { expectedVersion: 1, selection: { note: false, updates: ["u1"] } })).rejects.toMatchObject({ code: "forbidden" });
    expect(state.approvals).toBe(0);
    const fallback = await scribe.approveAndWrite(actor(), ID, { expectedVersion: 1, selection: { note: true, updates: [] } });
    expect(fallback.writes).toEqual([expect.objectContaining({ item: "note", status: "unsupported", copyText: expect.stringContaining("Subjective:") })]);
    // The note is not in the chart, so the transcript is kept until it expires.
    expect(fallback).toMatchObject({ status: "approved", transcriptDeleted: false });
  });
  it("marks the physician's edits and keeps the sources of untouched statements", async () => {
    const { scribe, view } = await recorded();
    const first = view.note!.sections.subjective[0];
    const edited = await scribe.editNote(actor(), ID, { expectedVersion: 1, sections: { subjective: [{ id: first.id, text: first.text }, { text: "Reports good adherence to diet." }], objective: [], assessment: [], plan: [] } });
    expect(edited.noteVersion).toBe(2);
    expect(edited.note!.sections.subjective[0]).toMatchObject({ sources: first.sources });
    expect(edited.note!.sections.subjective[0].editedByClinician).toBeUndefined();
    expect(edited.note!.sections.subjective[1]).toMatchObject({ editedByClinician: true, sources: [] });
  });
});

describe("FHIR writer", () => {
  const grant = { baseUrl: "https://ehr.example.test/fhir", accessToken: "fictional-token", patientId: "fic-pt-1", encounterId: "fic-enc-1", practitionerReference: "Practitioner/fic-dr-1",
    grantedScopes: ["launch", "patient/DocumentReference.c", "patient/AllergyIntolerance.cruds", "patient/Observation.rs"] };
  function ehr(status = 201) {
    const calls: { method: string; url: string; headers: Headers; body?: Record<string, unknown> }[] = [];
    const request = (async (target: URL | string | Request, init?: RequestInit) => {
      const url = String(target);
      calls.push({ method: init?.method ?? "GET", url, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/metadata")) return Response.json({ rest: [{ resource: [{ type: "DocumentReference", interaction: [{ code: "create" }] }, { type: "AllergyIntolerance", interaction: [{ code: "create" }, { code: "read" }] }, { type: "Condition", interaction: [{ code: "read" }] }] }] });
      return Response.json({ id: "fic-created-1" }, { status });
    }) as typeof fetch;
    return { request, calls };
  }
  const note: ChartWriteItem = { kind: "document", itemKey: "sl-0123456789abcdef-note", documentType: "soap_note", title: "Visit note (SOAP)", text: "Subjective:\n- Fictional.", language: "en" };

  it("recognizes create scopes in SMART v2 and v1 form only", () => {
    expect(grantsCreate(["patient/Condition.c"], "Condition")).toBe(true);
    expect(grantsCreate(["patient/Condition.write"], "Condition")).toBe(true);
    expect(grantsCreate(["user/*.cruds"], "Condition")).toBe(true);
    expect(grantsCreate(["patient/Condition.rs", "patient/Condition.read", "patient/AllergyIntolerance.c"], "Condition")).toBe(false);
  });
  it("creates a note conditionally for the launched patient and visit, authored by the clinician", async () => {
    const { request, calls } = ehr();
    expect(await createFhirWriter(grant, request).create(note)).toEqual({ status: "created", resourceType: "DocumentReference", resourceId: "fic-created-1" });
    const post = calls.find((call) => call.method === "POST")!;
    expect(post.url).toBe("https://ehr.example.test/fhir/DocumentReference");
    expect(post.headers.get("if-none-exist")).toBe("identifier=" + encodeURIComponent("urn:stetholink:chart-write|sl-0123456789abcdef-note"));
    expect(post.headers.get("authorization")).toBe("Bearer fictional-token");
    expect(post.body).toMatchObject({ resourceType: "DocumentReference", status: "current", docStatus: "preliminary", subject: { reference: "Patient/fic-pt-1" },
      context: { encounter: [{ reference: "Encounter/fic-enc-1" }] }, author: [{ reference: "Practitioner/fic-dr-1" }], identifier: [{ system: "urn:stetholink:chart-write", value: "sl-0123456789abcdef-note" }] });
    expect(Buffer.from((post.body!.content as { attachment: { data: string } }[])[0].attachment.data, "base64").toString("utf8")).toBe(note.text);
    // Create only: there is no update or delete to issue.
    expect(calls.every((call) => ["GET", "POST"].includes(call.method))).toBe(true);
  });
  it("reports an existing record instead of creating a second one", async () => {
    const { request } = ehr(200);
    expect(await createFhirWriter(grant, request).create(note)).toMatchObject({ status: "existing", resourceId: "fic-created-1" });
  });
  it("writes a patient-reported allergy as unconfirmed unless the physician confirmed it", async () => {
    const { request, calls } = ehr();
    const writer = createFhirWriter(grant, request);
    await writer.create({ kind: "allergy", itemKey: "sl-0123456789abcdef-u1", substance: "Sulfa", reaction: "skin rash", intolerance: false, confirmedByPhysician: false });
    await writer.create({ kind: "allergy", itemKey: "sl-0123456789abcdef-u2", substance: "Peanut", intolerance: false, confirmedByPhysician: true });
    const [first, second] = calls.filter((call) => call.method === "POST").map((call) => call.body as { verificationStatus: { coding: { code: string }[] }; code: { text: string }; patient: { reference: string } });
    expect(first).toMatchObject({ code: { text: "Sulfa" }, patient: { reference: "Patient/fic-pt-1" }, reaction: [{ manifestation: [{ text: "skin rash" }] }] });
    expect(first.verificationStatus.coding[0].code).toBe("unconfirmed");
    expect(second.verificationStatus.coding[0].code).toBe("confirmed");
  });
  it("does not attempt a resource without a create scope or without server support", async () => {
    const { request, calls } = ehr();
    const writer = createFhirWriter(grant, request);
    expect(await writer.create({ kind: "medication", itemKey: "sl-0123456789abcdef-u3", name: "Metformin" })).toMatchObject({ status: "unsupported", resourceType: "MedicationStatement" });
    const widened = createFhirWriter({ ...grant, grantedScopes: [...grant.grantedScopes, "patient/Condition.c"] }, request);
    expect(await widened.create({ kind: "condition", itemKey: "sl-0123456789abcdef-u4", name: "Asthma" })).toMatchObject({ status: "unsupported", failure: expect.stringContaining("does not accept") });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });
  it("reports a refusal without retrying or changing anything", async () => {
    const { request, calls } = ehr(403);
    expect(await createFhirWriter(grant, request).create(note)).toMatchObject({ status: "failed", failure: "The EHR refused the write for this session" });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(() => createFhirWriter({ ...grant, baseUrl: "http://ehr.example.test/fhir" }, request)).toThrow();
  });
});

describe("transcription providers and configuration", () => {
  const request = { audio, sequence: 0, mimeType: "audio/webm", durationSeconds: 30, language: "ar-SA", hints: ["Metformin 500 mg oral tablet"], dataClassification: "synthetic" as const };
  it("the stand-in never takes live speech", async () => {
    await expect(mockTranscription.transcribe({ ...request, dataClassification: "live" })).rejects.toMatchObject({ code: "provider_unavailable" });
    expect((await mockTranscription.transcribe(request)).estimatedCostUsd).toBe(0);
  });
  it("sends live speech only to an approved provider, with the configured price and no identifiers", async () => {
    const calls: { url: string; form: FormData; auth: string | null }[] = [];
    const http = (async (url: URL | string | Request, init?: RequestInit) => { calls.push({ url: String(url), form: init!.body as FormData, auth: new Headers(init!.headers).get("authorization") }); return Response.json({ text: "تاخذ metformin بانتظام؟" }); }) as typeof fetch;
    const settings = { apiKey: "fictional-key", model: "gpt-transcribe", usdPerMinute: 0.0045 };
    await expect(createOpenAITranscription(settings, http).transcribe({ ...request, dataClassification: "live" })).rejects.toMatchObject({ code: "provider_unavailable", message: expect.stringContaining("TRANSCRIPTION_LIVE_DATA_APPROVED") });
    await expect(createOpenAITranscription({ ...settings, usdPerMinute: undefined }, http).transcribe(request)).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(calls).toHaveLength(0);
    const result = await createOpenAITranscription({ ...settings, liveDataApproved: true }, http).transcribe({ ...request, dataClassification: "live" });
    expect(result).toMatchObject({ estimatedCostUsd: 0.00225, audioSeconds: 30, segments: [{ text: "تاخذ metformin بانتظام؟", startMs: 0, endMs: 30000 }] });
    expect(calls[0].url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(calls[0].form.get("model")).toBe("gpt-transcribe");
    expect(calls[0].form.get("language")).toBe("ar");
    expect(calls[0].form.get("prompt")).toBe("Metformin 500 mg oral tablet");
  });
  it("live mode with the scribe on needs an approved, priced, real transcription provider", () => {
    const base = { CLINICAL_DATA_MODE: "live", AUTH_MODE: "smart", CLINICAL_DATA_SOURCE: "fhir", STETHOLINK_DATABASE_URL: "postgres://x@db.example.test/x", AI_PROVIDER: "openai", OPENAI_API_KEY: "k",
      OPENAI_INPUT_USD_PER_MILLION: "1", OPENAI_OUTPUT_USD_PER_MILLION: "1", MODEL_LIVE_DATA_APPROVED: "true", SCRIBE_ENABLED: "true" };
    expect(() => parseEnv(base)).toThrow(/TRANSCRIPTION_PROVIDER must be a real provider/);
    const scribe = { ...base, TRANSCRIPTION_PROVIDER: "openai", TRANSCRIPTION_USD_PER_MINUTE: "0.0045", TRANSCRIPTION_LIVE_DATA_APPROVED: "true", SCRIBE_NOTE_INPUT_USD_PER_MILLION: "0.25", SCRIBE_NOTE_OUTPUT_USD_PER_MILLION: "2" };
    expect(liveModeProblems(parseEnv(scribe))).toEqual([]);
    expect(() => parseEnv({ ...scribe, TRANSCRIPTION_USD_PER_MINUTE: "0.02" })).toThrow(/above TRANSCRIPTION_MAX_USD_PER_MINUTE/);
    expect(() => parseEnv({ ...scribe, TRANSCRIPTION_LIVE_DATA_APPROVED: "false" })).toThrow(/TRANSCRIPTION_LIVE_DATA_APPROVED/);
    // Audio is never stored: no other retention value exists.
    expect(() => parseEnv({ ...scribe, SCRIBE_AUDIO_RETENTION: "30d" })).toThrow();
  });
});
