import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createOpenAIProvider } from "@/core/agent/providers/openai-provider";
import type { ModelProvider, ModelRequest } from "@/core/agent/providers/types";
import { clinicalSafetyGuard } from "@/core/agent/safety/guard";
import { AUTHORING_INSTRUCTIONS, buildAuthoringInput, referralFormat, validateReferral, type AuthoringContext } from "@/core/consultation/authoring";
import type { ChartIdentity } from "@/core/privacy/ports";
import { PRIVACY_NOTE, createPseudonymizingProvider } from "@/core/privacy/provider";
import { createSurrogateState, hideDocuments, hideText, registerIdentity, remainingIdentifiers, restoreDocument, type SurrogateState } from "@/core/privacy/pseudonymizer";
import { generateScribeNote } from "@/core/scribe/generate";
import { SCRIBE_INSTRUCTIONS, buildNoteInput, scribeNoteFormat, type NoteContext } from "@/core/scribe/note";
import { createFhirConnector } from "@/integrations/fhir/connector";
import type { KnownClinicalFact } from "@/shared/contracts";
import { FICTIONAL_VISIT_START, FORBIDDEN_IN_MODEL_REQUESTS, fictionalIdentity, fictionalRequest, fictionalTranscript } from "../fixtures/identities";
import { deidentified, testVault } from "../helpers/privacy";

vi.mock("server-only", () => ({}));

const fresh = (identity: ChartIdentity = fictionalIdentity) => { const state = createSurrogateState(identity.anchorDate); registerIdentity(state, identity); return state; };
const fact = (id: string, category: KnownClinicalFact["category"], label: string, value: KnownClinicalFact["value"], unit: string | undefined, timestamp: string): KnownClinicalFact =>
  ({ id, category, label, status: "known", value, ...(unit ? { unit } : {}), source: { type: "fhir", reference: `Observation/${id}` }, timestamp });
// Fact ids as the connector makes them: a prefix and sixteen hex digits, one of them all digits.
const facts = [
  fact("vital-0123456789abcdef", "vital_sign", "Blood pressure", "150/95", "mmHg", "2026-03-10T07:40:00.000Z"),
  fact("lab-1234567812345678", "investigation", "Troponin I", 0.04, "ng/mL", "2026-03-07T09:15:00.000Z"),
  fact("med-fedcba9876543210", "medication", "Amlodipine 5 mg oral tablet", "5 mg once daily", undefined, "2025-12-10T00:00:00.000Z"),
  fact("problem-00aa11bb22cc33dd", "problem", "Essential hypertension", true, undefined, "2023-09-21T00:00:00.000Z"),
];
const authoring: AuthoringContext = {
  physicianRequest: fictionalRequest,
  clarifications: [{ question: "Which specialty?", answer: "Cardiology. Ask for Dr. Tariq Hamdan; the family number is 0112223344, e-mail nurse.station@example.invalid." }] as AuthoringContext["clarifications"],
  demographics: { age: "58 years", sex: "male" }, reasonForVisit: "Chest pain on exertion, referred by Nurse Huda Alshehri on 3 March 2026",
  availableSpecialties: ["Cardiology"], facts, eligibleFacts: facts, missing: [],
};
const note: NoteContext = {
  segments: fictionalTranscript.map((segment, index) => ({ ...segment, speaker: null, startMs: index * 5000, endMs: index * 5000 + 4000 })),
  facts, demographics: { age: "58 years", sex: "male" }, noteLanguage: "en", spokenLanguage: "ar",
};
const envelope = (text: string) => ({ status: "completed", model: "test-model", usage: { input_tokens: 10, output_tokens: 10 },
  output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] }] });
/** The real OpenAI provider behind the real layer, with the network replaced: what is captured is the exact HTTP body that would leave the server. */
function wired(reply: (body: { instructions: string; input: Array<{ content: string }> }) => string, identity: ChartIdentity = fictionalIdentity) {
  const bodies: string[] = [];
  const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return Response.json(envelope(reply(JSON.parse(String(init?.body)))));
  });
  const vault = testVault();
  const provider = deidentified(createOpenAIProvider({ apiKey: "test-key", model: "test-model", maxInputTokens: 60_000, inputUsdPerMillion: 1, outputUsdPerMillion: 1, liveDataApproved: true },
    request as typeof fetch), identity, vault);
  return { provider, bodies, request, vault };
}
const consultationRequest = (context: AuthoringContext): ModelRequest =>
  ({ instructions: AUTHORING_INSTRUCTIONS, messages: [{ role: "user", content: buildAuthoringInput(context) }], dataClassification: "live", structuredOutput: referralFormat });
const noteRequest = (context: NoteContext): ModelRequest =>
  ({ instructions: SCRIBE_INSTRUCTIONS, messages: [{ role: "user", content: buildNoteInput(context) }], dataClassification: "live", structuredOutput: scribeNoteFormat });
const emptyReferral = JSON.stringify({ specialty: "Cardiology", clinicalQuestion: "q", sections: Object.fromEntries(Object.keys((referralFormat.schema.properties.sections as { properties: object }).properties).map((key) => [key, []])),
  missingInformation: [], suggestedAdditionalInformation: [], requestReview: { verdict: "proceed", concerns: [] } });

describe("no identifier reaches the model provider", () => {
  it.each([
    ["a consultation request", () => consultationRequest(authoring)],
    ["a consultation revision", () => consultationRequest({ ...authoring, revision: { instruction: "Mention that محمد العتيبي was seen by الدكتور زياد الدوسري", specialty: "Cardiology", clinicalQuestion: "Is Mohamed Alotaibi fit for surgery?",
      currentRequestText: "Consultation request for MOHAMMED AL-OTAIBI, file 2201456789", currentSuggestions: ["Call Nurse Huda on +966 55 000 1234"] } })],
    ["a scribe note", () => noteRequest(note)],
  ])("%s: the HTTP body holds none of the known spellings", async (_name, build) => {
    const { provider, bodies } = wired(() => "{}");
    await provider.generate(build());
    expect(bodies).toHaveLength(1);
    const folded = bodies[0].normalize("NFKD").replace(/[ً-ٰٟـ]/g, "");
    for (const forbidden of FORBIDDEN_IN_MODEL_REQUESTS) {
      expect(bodies[0].toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase());
      expect(folded, forbidden).not.toContain(forbidden.normalize("NFKD").replace(/[ً-ٰٟـ]/g, ""));
    }
    // Nothing that looks like a record number, a phone number, an address of a person or a calendar date is left either.
    const sent = (JSON.parse(bodies[0]) as { input: Array<{ content: string }> }).input.map((message) => message.content).join("\n");
    expect(sent.replace(/"[a-z_]+-[0-9a-f]{16}"/g, "")).not.toMatch(/[0-9٠-٩]{8,}|@|https?:|\b20\d\d-\d\d-\d\d\b/);
    expect(JSON.parse(bodies[0]).instructions).toContain(PRIVACY_NOTE);
  });

  it("replaces names written with attached particles, diacritics, other spellings and the other script", () => {
    const state = fresh();
    const out = hideText(state, "ومحمد، لمحمّد، بمحمد، مُحَمَّد العُتَيبي، للعتيبي، Mohamed ALOTAIBI, muhammad al otaibi, عبد الله and Abdallah; Nora نوره");
    expect(out).not.toMatch(/محم|عتيب|moham|muham|otaibi|عبد|abd|نور/iu);
    expect(remainingIdentifiers(state, out)).toBe(0);
    // One person, one stand-in, whatever the spelling; the two scripts are the same stand-in person.
    const [arabic, latin] = [hideText(state, "محمد"), hideText(state, "Mohammed")];
    expect(hideText(state, "مُحَمَّد")).toBe(arabic);
    expect(hideText(state, "Muhammad")).toBe(latin);
    expect(restoreDocument(state, `${arabic} / ${latin}`)).toBe("محمد / Mohammed");
  });

  it("finds people the chart does not name: after a title, by a common given name, with a family name or a patronymic", () => {
    const state = fresh({ people: [], identifiers: [] });
    const text = "الدكتورة ريما الشمري قالت إن فهد بن جلوي راجع الممرضة وجدان. Dr. Kowalski and Nurse Maria Santos saw Ahmed Al-Zahrani; my name is Yusuf.";
    const out = hideText(state, text);
    for (const name of ["ريما", "الشمري", "فهد", "جلوي", "وجدان", "Kowalski", "Maria", "Santos", "Ahmed", "Zahrani", "Yusuf"]) expect(out, name).not.toContain(name);
    expect(restoreDocument(state, out)).toBe(text);
  });

  it("keeps ordinary words that only resemble a name", () => {
    const state = fresh({ people: [{ role: "patient", sex: "male", names: [{ given: ["علي"], family: "Sami" }, { text: "Tamer" }] }], identifiers: [] });
    const text = "يعتمد على الدواء نفسه؛ the same tumor, a timer, الكريم الموضعي";
    expect(hideText(state, text)).toBe(text);
    expect(hideText(state, "علي و Sami و Tamer")).not.toMatch(/علي|Sami|Tamer/);
  });

  it("refuses to send when the chart's identifiers cannot be loaded, and when one survives replacement", async () => {
    const inner: ModelProvider = { name: "inner", generate: vi.fn() };
    const failing = createPseudonymizingProvider(inner, { sessionKey: "s", expiresAt: Date.now() + 1000, identity: async () => { throw new Error("Patient محمد unreadable"); } }, testVault());
    const error = await failing.generate(consultationRequest(authoring)).catch((caught: Error) => caught);
    expect(error).toMatchObject({ code: "provider_unavailable" });
    expect((error as Error).message).not.toContain("محمد");
    // An identifier glued to other letters is not replaced; the independent check still sees a known number inside it.
    const surviving = deidentified(inner, { people: [], identifiers: ["778899001122"] });
    await expect(surviving.generate({ ...consultationRequest(authoring), messages: [{ role: "user", content: "ref X778899001122Y" }] })).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(inner.generate).not.toHaveBeenCalled();
  });

  it("the provider itself refuses a request that did not pass through the layer", async () => {
    const request = vi.fn();
    const bare = createOpenAIProvider({ apiKey: "test-key", model: "m", inputUsdPerMillion: 1, outputUsdPerMillion: 1, liveDataApproved: true }, request as typeof fetch);
    await expect(bare.generate(consultationRequest(authoring))).rejects.toMatchObject({ code: "forbidden" });
    expect(request).not.toHaveBeenCalled();
  });

  it("only the model boundary builds a provider, and it always returns the layer", () => {
    const root = resolve(import.meta.dirname, "../..");
    const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
      entry.name === "node_modules" || entry.name === ".next" ? [] : entry.isDirectory() ? files(join(directory, entry.name)) : /\.(?:ts|tsx|mts)$/.test(entry.name) ? [join(directory, entry.name)] : []);
    const builders = ["apps", "core", "platform", "integrations", "shared", "scripts"].flatMap((directory) => files(join(root, directory)))
      .filter((file) => /createOpenAIProvider\s*\(/.test(readFileSync(file, "utf8"))).map((file) => relative(root, file).replaceAll("\\", "/"));
    expect(builders.sort()).toEqual(["core/agent/providers/openai-provider.ts", "platform/tenants/model-provider.ts"]);
    const boundary = readFileSync(join(root, "platform/tenants/model-provider.ts"), "utf8");
    expect(boundary.match(/createOpenAIProvider\s*\(/g)).toHaveLength(1);
    expect(boundary).toMatch(/return createPseudonymizingProvider\(provider, privacy, createMemoryVault\(\)\);/);
    expect(readFileSync(join(root, "apps/embedded-app/server/scribe.ts"), "utf8")).toContain('getModelProvider(modelPrivacy(session, adapter), "scribe_note")');
  });
});

describe("clinical meaning is unchanged", () => {
  it("age, sex, vitals, laboratory values, units, doses and durations leave exactly as they were", async () => {
    const { provider, bodies } = wired(() => emptyReferral);
    await provider.generate(consultationRequest(authoring));
    const sent = JSON.parse((JSON.parse(bodies[0]) as { input: Array<{ content: string }> }).input[0].content);
    expect(sent.chart.patient).toEqual({ age: "58 years", sex: "male" });
    expect(sent.chart.facts.map((entry: { id: string; label: string; value: unknown; unit: string | null }) => [entry.id, entry.label, entry.value, entry.unit])).toEqual(facts.map((entry) => [entry.id, entry.label, entry.value, entry.unit ?? null]));
    expect(sent.chart.citableFactIds).toEqual(facts.map((entry) => entry.id));
    for (const value of ["chest pain for 3 days", "BP 150/95 mmHg", "troponin 0.04 ng/mL", "amlodipine 5 mg once daily"]) expect(sent.physicianRequest).toContain(value);
  });

  it("the spoken visit keeps every reading and dose", () => {
    const state = fresh();
    const [out] = hideDocuments(state, [buildNoteInput(note)]);
    const texts = (JSON.parse(out) as { transcript: { segments: Array<{ id: string; text: string }> } }).transcript.segments;
    expect(texts.map((segment) => segment.id)).toEqual(fictionalTranscript.map((segment) => segment.id));
    for (const index of [1, 2, 6]) expect(texts[index].text).toBe(fictionalTranscript[index].text);
    expect(texts[3].text).toContain("أملوديبين 5 ملغ مرة في اليوم");
    expect(texts[4].text).toContain("حساسية من البنسلين");
  });

  it("numbers that are not identifiers are left alone", () => {
    const state = fresh();
    for (const text of ["WBC 11.2 x10^9/L, platelets 250000, creatinine 1.1 mg/dL", "BP 120/80, HR 72, SpO2 98%, temp 37.2 C", "Metformin 1000 mg twice daily for 6 months", "1/2 tablet at 08:00 and 20:00",
      "INR 2.5; eGFR 60 mL/min/1.73m2", "3 years ago, in 2019, 2 weeks after surgery", "الجرعة ٥٠٠ ملغ كل ٨ ساعات لمدة ٧ أيام"]) expect(hideText(state, text)).toBe(text);
  });

  it("dates become day offsets from the visit, so every interval stays true", () => {
    const state = fresh();
    expect(hideText(state, "2026-03-10 | 2026-03-07 | 07/03/2026 | 3 March 2026 | March 3, 2026 | ٥ مارس ٢٠٢٦ | 2025-12-10T08:30:00Z | 2026-03-17"))
      .toBe("T+0d | T-3d | T-3d | T-7d | T-7d | T-5d | T-90d 08:30:00 | T+7d");
    // A date the layer cannot place on the calendar (Hijri) is hidden whole; an impossible one is not a date.
    expect(hideText(state, "1447/09/21 and 31/02/2026")).toBe("DATE-A and 31/02/2026");
    expect(state.anchor).toBe(FICTIONAL_VISIT_START.slice(0, 10));
  });
});

describe("the physician sees real values again", () => {
  it("round trip: every stand-in in the answer becomes the value it replaced", () => {
    const state = fresh();
    const document = buildAuthoringInput(authoring);
    const [out] = hideDocuments(state, [document]);
    const back = JSON.parse(restoreDocument(state, out));
    const original = JSON.parse(document);
    expect(back.chart).toEqual(original.chart);
    expect(back.clarifications).toEqual(original.clarifications);
    // The second spelling of the patient's name comes back in the chart's spelling: the same person, the real name.
    expect(back.physicianRequest).toBe(original.physicianRequest.replace("Muhammad", "Mohammed"));
  });

  it("an answer written by the model in its own words is mapped back, in either script", async () => {
    const { provider } = wired((body) => {
      const sent = JSON.parse(body.input[0].content) as { physicianRequest: string; chart: { facts: Array<{ documentedAt: string }> } };
      const [, given, family, record, seen] = /for (\S+) (\S+) \((\S+), national ID \S+\), seen on (\S+)/.exec(sent.physicianRequest)!;
      return JSON.stringify({ summary: `${given} ${family} (${record}), seen ${seen}; troponin measured ${sent.chart.facts[1].documentedAt}; ${given.toUpperCase()} is stable. T-1d follow-up.` });
    });
    const result = await provider.generate(consultationRequest(authoring));
    expect(JSON.parse(result.text).summary).toBe("Mohammed Al-Otaibi (MRN-00482913), seen 07/03/2026; troponin measured 2026-03-07T09:15:00.000Z; MOHAMMED is stable. 2026-03-09 follow-up.");
  });

  it("a consultation statement that cites a dated fact still validates against the chart", async () => {
    const { provider, bodies } = wired((body) => {
      const sent = JSON.parse(body.input[0].content) as { chart: { facts: Array<{ id: string; label: string; value: unknown; unit: string | null; documentedAt: string }> } };
      const lab = sent.chart.facts[1];
      const referral = JSON.parse(emptyReferral);
      referral.clinicalQuestion = "Is the chest pain cardiac?";
      referral.sections[Object.keys(referral.sections)[0]] = [{ text: `${lab.label} ${lab.value} ${lab.unit} documented ${lab.documentedAt.slice(0, 4)}`, evidenceIds: [lab.id] }];
      return JSON.stringify(referral);
    });
    const result = await provider.generate(consultationRequest(authoring));
    expect(bodies[0]).toContain("T-3d");
    const referral = validateReferral(result.text, authoring);
    expect(referral.rejectedStatements).toBe(0);
    // The day comes back the way the physician wrote it in this request.
    expect(Object.values(referral.sections).flat()[0].text).toBe("Troponin I 0.04 ng/mL documented 07/03/2026");
  });

  it("a scribe note that quotes the visit validates and reads with the real names", async () => {
    const { provider, bodies } = wired((body) => {
      const sent = JSON.parse(body.input[0].content) as { transcript: { segments: Array<{ id: string; text: string }> } };
      const text = (id: string) => sent.transcript.segments.find((segment) => segment.id === id)!.text;
      const doctor = /الدكتور (\S+ \S+)/u.exec(text("s4"))![1];
      const patient = /يا (\S+?)،/u.exec(text("s1"))![1];
      return JSON.stringify({
        subjective: [{ text: `${patient} reports chest pain for three days; seen earlier by Dr ${doctor}`, sources: [{ id: "s2", quote: "عندي ألم في الصدر من ثلاثة أيام" }, { id: "s4", quote: text("s4").split(" وقال")[0] }] },
          { text: "Penicillin allergy reported", sources: [{ id: "s5", quote: text("s5").split("،")[0] }] }],
        objective: [{ text: "BP 150/95, pulse 88, temperature 37.2", sources: [{ id: "s3", quote: text("s3") }] }],
        assessment: [], plan: [{ text: "Start aspirin 81 mg daily; repeat ECG in one week", sources: [{ id: "s7", quote: text("s7") }] }],
        clinicianSegments: ["s1", "s3", "s7"], patientSegments: ["s2", "s4", "s5", "s6"], proposedUpdates: [],
      });
    });
    const { note: written } = await generateScribeNote({ provider, safety: clinicalSafetyGuard, dataClassification: "live" }, note);
    expect(bodies).toHaveLength(1);
    expect(written.rejectedStatements).toBe(0);
    expect(written.sections.subjective[0].text).toBe("محمد reports chest pain for three days; seen earlier by Dr زياد الدوسري");
    expect(written.sections.subjective[0].sources[1]).toMatchObject({ id: "s4", quote: "الدكتور زياد الدوسري شافني يوم ٥ مارس" });
    // The name comes back in the chart's spelling (no diacritics), with the particle the speaker attached.
    expect(written.sections.subjective[1].sources[0].quote).toBe("ولمحمد حساسية من البنسلين");
    expect(written.sections.objective[0].text).toBe("BP 150/95, pulse 88, temperature 37.2");
  });
});

describe("the stand-in map", () => {
  it("is consistent for the session and different between sessions", async () => {
    const { provider, bodies, vault } = wired(() => "{}");
    await provider.generate(consultationRequest(authoring));
    await provider.generate(noteRequest(note));
    const name = (text: string, pattern: RegExp) => pattern.exec(text)![1];
    const first = name(JSON.parse(JSON.parse(bodies[0]).input[0].content).physicianRequest, /for (\S+) /);
    const state = vault.state as SurrogateState;
    expect(restoreDocument(state, first)).toBe("Mohammed");
    expect(JSON.parse(JSON.parse(bodies[1]).input[0].content).transcript.segments[0].text).toContain(hideText(state, "محمد"));
    const standIns = new Set(Array.from({ length: 12 }, () => hideText(fresh(), "Mohammed")));
    expect(standIns.size).toBeGreaterThan(1);
  });

  it("is kept in memory only until the session ends, and is never logged", async () => {
    const { createMemoryVault } = await import("@/platform/privacy/vault");
    let now = 1_000;
    const store = new Map();
    const vault = createMemoryVault(() => now, store);
    const state = vault.open("session-a", 5_000, () => fresh());
    expect(vault.open("session-a", 5_000, () => fresh())).toBe(state);
    expect(vault.open("session-b", 5_000, () => fresh())).not.toBe(state);
    now = 5_000;
    expect(vault.open("session-a", 9_000, () => fresh())).not.toBe(state);
    expect(store.has("session-b")).toBe(false);
    // A session that is already over keeps nothing.
    vault.open("session-c", 4_000, () => fresh());
    expect(store.has("session-c")).toBe(false);

    const streams = (["log", "info", "warn", "error", "debug"] as const).map((stream) => vi.spyOn(console, stream).mockImplementation(() => undefined));
    const { provider } = wired(() => "{}");
    await provider.generate(consultationRequest(authoring));
    const failing = deidentified({ name: "inner", generate: async () => { throw new Error("upstream"); } });
    await failing.generate(consultationRequest(authoring)).catch(() => undefined);
    expect(streams.flatMap((stream) => stream.mock.calls)).toEqual([]);
    streams.forEach((stream) => stream.mockRestore());
  });
});

describe("what the EHR says about who is named", () => {
  const resources: Record<string, unknown> = {
    "Patient/fic-pt-77": { resourceType: "Patient", id: "fic-pt-77", gender: "male", name: [{ given: ["محمد"], family: "العتيبي" }, { given: ["Mohammed"], family: "Al-Otaibi" }],
      identifier: [{ value: "MRN-00482913" }], telecom: [{ value: "+966 55 000 1234" }], address: [{ line: ["Building 12, Fictional Street"], postalCode: "12345" }],
      contact: [{ name: { text: "نورة سعد العتيبي" }, gender: "female", telecom: [{ value: "0550009876" }] }] },
    "Encounter/fic-enc-204": { resourceType: "Encounter", id: "fic-enc-204", period: { start: FICTIONAL_VISIT_START }, participant: [{ individual: { reference: "Practitioner/fic-pr-9", display: "Dr Ziyad Aldosari" } }] },
    "Practitioner/fic-pr-3": { resourceType: "Practitioner", id: "fic-pr-3", gender: "female", name: [{ given: ["Huda"], family: "Alshehri" }] },
    "RelatedPerson": { resourceType: "Bundle", entry: [{ resource: { resourceType: "RelatedPerson", id: "fic-rp-1", patient: { reference: "Patient/fic-pt-77" }, name: [{ given: ["Saad"], family: "Al-Otaibi" }], telecom: [{ value: "0550005555" }] } }] },
  };
  const connector = (denied: string[] = []) => createFhirConnector({ baseUrl: "https://ehr.example.invalid/fhir", accessToken: "t", patientId: "fic-pt-77", encounterId: "fic-enc-204", practitionerReference: "Practitioner/fic-pr-3" },
    (async (url: string) => {
      const path = new URL(url).pathname.replace("/fhir/", "");
      return denied.includes(path) || !resources[path] ? new Response("{}", { status: 403 }) : Response.json(resources[path]);
    }) as typeof fetch);

  it("reads the patient, contacts, relatives, the clinician and the visit start", async () => {
    const identity = await connector().getIdentity();
    expect(identity.anchorDate).toBe(FICTIONAL_VISIT_START);
    expect(identity.people.map((person) => person.role)).toEqual(["patient", "relative", "relative", "staff", "staff"]);
    expect(identity.identifiers).toEqual(expect.arrayContaining(["fic-pt-77", "fic-enc-204", "MRN-00482913", "+966 55 000 1234", "0550009876", "fic-rp-1", "0550005555", "fic-pr-3"]));
    expect(identity.addresses).toEqual(["Building 12, Fictional Street", "12345"]);
    const state = fresh(identity);
    expect(hideText(state, "Saad, Dr Ziyad Aldosari and هدى؟ Huda Alshehri, 055 000 5555")).not.toMatch(/Saad|Ziyad|Aldosari|Huda|Alshehri|5555/);
  });

  it("works with what the EHR grants, and fails when the patient record itself cannot be read", async () => {
    const partial = await connector(["RelatedPerson", "Practitioner/fic-pr-3", "Encounter/fic-enc-204"]).getIdentity();
    expect(partial.people.map((person) => person.role)).toEqual(["patient", "relative"]);
    expect(partial.anchorDate).toBeUndefined();
    await expect(connector(["Patient/fic-pt-77"]).getIdentity()).rejects.toThrow();
  });
});
