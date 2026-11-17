import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ClinicianContext } from "@/core/auth/clinician";
import type { ModelProvider, ModelResult } from "@/core/agent/providers/types";
import { clinicalSafetyGuard } from "@/core/agent/safety/guard";
import { MIN_OVERRIDE_REASON, flagsFor, requiredAcknowledgements } from "@/core/orders/flags";
import { createOrderService, orderCopyText } from "@/core/orders/service";
import { LocaleProvider } from "@/apps/embedded-app/i18n/client";
import { messages } from "@/apps/embedded-app/i18n/messages";
import {
  MIN_REASON, OrderChartView, OrderDraftView, OrderLineCard, OrderReviewLoaded, decisionsToRecord, describeFlag, groupByKind, isComplete, requiredKinds, splitInteraction,
  type LineChoice, type OrderAccess,
} from "@/apps/embedded-app/features/orders";
import { describeFact, factsOf } from "@/apps/embedded-app/features/orders/hooks/orderText";
import type { ChartWriteResult, OrderDraft, OrderFlag, OrderLineDecision } from "@/shared/contracts";
import { ORDER_CATALOG, ORDER_FACTS, memoryOrderRepository, orderChart } from "@/tests/fixtures/orders";

// FICTIONAL DATA ONLY. The drafts below come from the product's own order service, a scripted model, the fictional catalog and the
// fictional chart of tests/fixtures/orders.ts (a penicillin allergy, an active warfarin, chest pain).
const physician: ClinicianContext = {
  clinicianId: "55555555-5555-4555-8555-555555555555", tenantId: "fictional-hospital", roles: ["physician"], scopes: ["chart:read", "order:draft", "order:approve"],
  patientId: "fic-pt-1", encounterId: "fic-enc-1", expiresAt: Date.now() + 600_000, authorization: "active", dataClassification: "live",
};
const line = (itemId: string, over: object = {}) => ({ itemId, requestedText: "", reason: "A fictional reason.", evidenceIds: [], ...over });
const scripted = (text: string): ModelProvider => ({
  name: "scripted",
  generate: vi.fn(async (): Promise<ModelResult> => ({ text, provider: "scripted", model: "scripted-1" })),
});
async function draftFor(request: string, answer: object, key: string): Promise<OrderDraft> {
  const chart = orderChart();
  const service = createOrderService({ repository: memoryOrderRepository(), provider: scripted(JSON.stringify(answer)), safety: clinicalSafetyGuard, adapter: chart.adapter, dataClassification: "live", catalog: ORDER_CATALOG });
  const result = await service.create({ request, idempotencyKey: key }, physician);
  if ("outcome" in result) throw new Error("expected a draft");
  return result;
}
/** The physician named a medicine they are allergic to, one that interacts with the chart's warfarin, warfarin itself, and a CBC. */
const specific = () => draftFor("Prepare amoxicillin, ibuprofen, warfarin and a CBC", {
  mode: "specific", unmatched: ["a kidney scan"],
  items: [line("med-amox", { requestedText: "amoxicillin" }), line("med-ibu", { requestedText: "ibuprofen" }), line("med-warf", { requestedText: "warfarin" }), line("lab-cbc", { requestedText: "CBC" })],
}, "ui-specific");
/** Orders the assistant proposed for the case, each with the chart fact it rests on. */
const proposed = () => draftFor("Prepare the basic orders for this case", {
  mode: "case_based", unmatched: [], items: [line("lab-trop", { reason: "Chest pain of two hours.", evidenceIds: ["symptom-1"] }), line("nur-obs", { reason: "Chest pain.", evidenceIds: ["symptom-1"] })],
}, "ui-proposed");

const inLocale = (locale: "en" | "ar", node: ReactElement) => renderToStaticMarkup(createElement(LocaleProvider, { locale }, node));
const visible = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&[a-z#0-9]+;/g, " ").replace(/\s+/g, " ");
/** A run of three English words: what a sentence left untranslated looks like. */
const ENGLISH_SENTENCE = /\b[A-Za-z]{2,}(?:'[a-z]+)?\s+[A-Za-z]{2,}\s+[A-Za-z]{2,}\b/;
const ISOLATES = /[⁦-⁩]/g;
const ARABIC = /[؀-ۿ]/;

describe("the rules the screen shares with the server", () => {
  it("asks for the acknowledgements the server asks for, and for a reason of the length the server wants", () => {
    const kinds = ["allergy", "allergies_unchecked", "duplicate_active", "duplicate_order", "interaction", "interactions_unchecked"] as const;
    const flags: OrderFlag[] = kinds.flatMap((kind) => [undefined, "major", "moderate", "minor"].map((severity) => ({ kind, ...(severity ? { severity: severity as "major" } : {}), text: "x", evidenceIds: [] })));
    for (const flag of flags) expect(requiredKinds([flag]).sort(), `${flag.kind} ${flag.severity}`).toEqual(requiredAcknowledgements([flag]).sort());
    // Several warnings on one order.
    const both = flags.filter((flag) => flag.kind === "allergy" || (flag.kind === "interaction" && flag.severity === "major"));
    expect(requiredKinds(both).sort()).toEqual(requiredAcknowledgements(both).sort());
    expect(MIN_REASON).toBe(MIN_OVERRIDE_REASON);
  });

  it("takes the hospital's interaction text apart from the context core adds, as core writes it today", () => {
    const [ibuprofen, warfarin] = ["med-ibu", "med-warf"].map((id) => ORDER_CATALOG.items.find((item) => item.id === id)!);
    const flags = flagsFor(ibuprofen, [warfarin], { catalog: ORDER_CATALOG, facts: ORDER_FACTS, existing: [] }).filter((flag) => flag.kind === "interaction");
    const rule = ORDER_CATALOG.interactions[0].text;
    expect(flags.map((flag) => splitInteraction(flag.text))).toEqual([
      { rule, context: { kind: "active", what: "Warfarin 5 mg oral tablet" } },
      { rule, context: { kind: "draft", what: warfarin.display } },
    ]);
    // A text that does not end the way core writes it is the hospital's text whole.
    expect(splitInteraction("A hospital rule (see policy 4)")).toEqual({ rule: "A hospital rule (see policy 4)" });
    expect(splitInteraction("Rule text")).toEqual({ rule: "Rule text" });
  });
});

describe("a flag in words", () => {
  const flagsOf = async () => (await specific()).lines.flatMap((entry) => entry.flags);
  const inWords = (flag: OrderFlag, locale: "en" | "ar") => describeFlag(flag, factsOf({ clinicalFacts: ORDER_FACTS }), messages[locale].work.orders.flags, locale, messages[locale].chart);

  it("builds the sentence from the kind and the cited facts, in both languages, and asks for an acknowledgement where the server will", async () => {
    const flags = await flagsOf();
    const allergy = flags.find((flag) => flag.kind === "allergy")!;
    const english = inWords(allergy, "en");
    expect(english).toMatchObject({ title: "Allergy", tone: "danger", needsAcknowledgement: true });
    expect(english.sentence.replace(ISOLATES, "")).toBe("The chart documents an allergy: Penicillins (Reaction: urticaria)");
    const arabic = inWords(allergy, "ar");
    expect(arabic).toMatchObject({ title: "حساسية", tone: "danger", needsAcknowledgement: true });
    expect(arabic.sentence.replace(ISOLATES, "")).toBe("يوثّق الملف حساسية: Penicillins (Reaction: urticaria)");
    // The English sentence core wrote is not what the Arabic screen shows.
    expect(arabic.sentence).not.toContain(allergy.text);
  });

  it("shows an interaction's own text as the hospital wrote it, with its severity and the context in the screen's language", async () => {
    const flags = await flagsOf();
    const active = flags.find((flag) => flag.kind === "interaction" && flag.text.includes("(active medication:"))!;
    const draft = flags.find((flag) => flag.kind === "interaction" && flag.text.includes("(also in this draft:"))!;
    const rule = ORDER_CATALOG.interactions[0].text;
    expect(inWords(active, "en")).toMatchObject({ title: "Major interaction", tone: "danger", hospitalText: rule, needsAcknowledgement: true });
    const arabic = inWords(active, "ar");
    expect(arabic).toMatchObject({ title: "تداخل دوائي كبير", tone: "danger", hospitalText: rule, needsAcknowledgement: true });
    expect(arabic.sentence.replace(ISOLATES, "")).toBe("مع دواء نشط في الملف: Warfarin 5 mg oral tablet (5 mg once daily)");
    expect(inWords(draft, "ar").sentence.replace(ISOLATES, "")).toBe(`مع أمر آخر في هذه المسودة: ${ORDER_CATALOG.items.find((item) => item.id === "med-warf")!.display}`);
    // Neither the context core wrote in English nor the whole English text reaches the Arabic screen.
    for (const view of [arabic, inWords(draft, "ar")]) expect(`${view.sentence} ${view.title}`).not.toMatch(/active medication|also in this draft/);
  });

  it("does not ask for an acknowledgement for a moderate or minor interaction or for a duplicate, and says what it could not check", async () => {
    const base = { text: "x", evidenceIds: [] as string[] };
    expect(inWords({ ...base, kind: "interaction", severity: "moderate", text: "A rule." }, "en")).toMatchObject({ title: "Moderate interaction", tone: "warning", needsAcknowledgement: false, hospitalText: "A rule." });
    expect(inWords({ ...base, kind: "interaction", severity: "minor", text: "A rule." }, "ar")).toMatchObject({ title: "تداخل دوائي طفيف", tone: "neutral", needsAcknowledgement: false });
    expect(inWords({ ...base, kind: "duplicate_order" }, "ar")).toMatchObject({ tone: "warning", sentence: "هذا الأمر مُعدّ أو معتمد بالفعل في هذه الزيارة.", needsAcknowledgement: false });
    expect(inWords({ ...base, kind: "allergies_unchecked" }, "en").sentence).toContain("was not checked against allergies");
    expect(inWords({ ...base, kind: "interactions_unchecked" }, "ar").sentence).toMatch(ARABIC);
    // A flag whose facts the draft does not hold is still a sentence, without the fact.
    expect(inWords({ ...base, kind: "duplicate_active", evidenceIds: ["unknown-id"] }, "en").sentence).toBe("The chart already lists an active order for this medicine.");
    expect(inWords({ ...base, kind: "allergy" }, "ar").sentence).toBe("يوثّق الملف حساسية لها صلة بهذا الأمر.");
  });

  it("writes every flag kind in Arabic without a sentence of English", async () => {
    const flags = await flagsOf();
    // What the chart and the catalog wrote (a fact's label and value, a medicine's name) is data and stays as written.
    const data = [...ORDER_FACTS.flatMap((fact) => [describeFact(fact, "ar", messages.ar.chart), fact.label]), ...ORDER_CATALOG.items.map((item) => item.display)].sort((a, b) => b.length - a.length);
    for (const flag of flags) {
      const view = inWords(flag, "ar");
      let rest = `${view.title} ${view.sentence.replace(ISOLATES, "")}`;
      for (const text of data) rest = rest.split(text).join(" ");
      expect(ENGLISH_SENTENCE.test(rest), `${flag.kind}: ${view.sentence}`).toBe(false);
    }
  });
});

describe("what is recorded", () => {
  it("groups the lines by kind in the order of the screen and leaves a kind with no line out", async () => {
    const draft = await specific();
    expect(groupByKind(draft.lines).map((group) => [group.kind, group.lines.map((entry) => entry.catalogItemId)])).toEqual([["lab", ["lab-cbc"]], ["medication", ["med-amox", "med-ibu", "med-warf"]]]);
  });

  it("sends the acknowledgements and the reason only where an order needs them, and nothing for what is not complete or not chosen", async () => {
    const draft = await specific();
    const [amox, ibu, warf, cbc] = ["med-amox", "med-ibu", "med-warf", "lab-cbc"].map((id) => draft.lines.find((entry) => entry.catalogItemId === id)!);
    expect(requiredKinds(amox.flags)).toEqual(["allergy"]);
    expect(requiredKinds(ibu.flags)).toEqual(["interaction"]);
    expect(requiredKinds(cbc.flags)).toEqual([]);
    const choices: Record<string, LineChoice> = {
      [cbc.id]: { choice: "approve", acknowledged: [], reason: "" },
      [amox.id]: { choice: "approve", acknowledged: ["allergy"], reason: "  The allergy was reviewed with the patient.  " },
      [ibu.id]: { choice: "approve", acknowledged: [], reason: "Long enough to be a reason" },       // acknowledgement missing
      [warf.id]: { choice: "reject", acknowledged: ["allergy"], reason: "ignored for a rejection" },
    };
    expect(isComplete(ibu, choices[ibu.id])).toBe(false);
    expect(isComplete(amox, { choice: "approve", acknowledged: ["allergy"], reason: "too short" })).toBe(false);
    // The lines go in the order of the draft; the incomplete approval is left out and counted.
    const expected: OrderLineDecision[] = [];
    for (const entry of draft.lines) {
      if (entry.id === amox.id) expected.push({ lineId: amox.id, decision: "approve", acknowledged: ["allergy"], overrideReason: "The allergy was reviewed with the patient." });
      else if (entry.id === warf.id) expected.push({ lineId: warf.id, decision: "reject" });
      else if (entry.id === cbc.id) expected.push({ lineId: cbc.id, decision: "approve" });
    }
    expect(decisionsToRecord(draft.lines, choices)).toEqual({ incomplete: 1, decisions: expected });
    // A line that was decided is never sent again.
    const decided = { ...draft, lines: draft.lines.map((entry) => (entry.id === cbc.id ? { ...entry, status: "approved" as const } : entry)) };
    expect(decisionsToRecord(decided.lines, { [cbc.id]: { choice: "approve", acknowledged: [], reason: "" } }).decisions).toEqual([]);
  });
});

describe("the draft on the screen", () => {
  it("shows who asked for each order, the cited facts, the checks in words and the catalog's own code and dose, in English", async () => {
    const asked = inLocale("en", createElement(OrderDraftView, { draft: await specific() }));
    for (const text of ["Order draft", "Laboratory tests", "Medications", "You asked for this", "Your words:", "Complete blood count", "Code:", "CBC-1", "Amoxicillin", "500 mg", "every 8 hours", "7 days",
      "Allergy", "Major interaction", "The chart documents an allergy:", "Penicillins (Reaction: urticaria)", ORDER_CATALOG.interactions[0].text,
      "To approve this order you must acknowledge this warning and give a reason.", "No warning does not mean an order is safe.",
      "Part of your request matched nothing", "a kidney scan", "Catalog version"]) expect(visible(asked), text).toContain(text);
    const proposedHtml = inLocale("en", createElement(OrderDraftView, { draft: await proposed() }));
    for (const text of ["Proposed by the assistant for this case", "Why:", "Chest pain of two hours.", "Based on the chart:", "Chest pain (two hours, pressing)", "Proposed for this case"]) expect(visible(proposedHtml), text).toContain(text);
    expect(proposedHtml).not.toContain("You asked for this");
  });

  it("is in Arabic, right to left, with what the hospital, the chart and the model wrote left as written", async () => {
    const draft = await specific();
    const html = inLocale("ar", createElement(OrderDraftView, { draft }));
    for (const text of ["مسودة الأوامر", "فحوصات المختبر", "الأدوية", "طلبتَ هذا الأمر", "كلماتك:", "الرمز:", "حساسية", "تداخل دوائي كبير", "يوثّق الملف حساسية:", "جزء من طلبك لم يطابق أي أمر", "إصدار الكتالوج", "بانتظار قرارك"]) expect(visible(html), text).toContain(text);
    // The catalog's names, the physician's words, the hospital's rule and the chart's entries are data: unchanged and read in their own direction.
    for (const data of ["Complete blood count", "Amoxicillin", "500 mg", ORDER_CATALOG.interactions[0].text, "a kidney scan", "Penicillins"]) expect(visible(html), data).toContain(data);
    expect(html).toContain('dir="auto"');
    expect(html).toMatch(/<bdi dir="ltr" class="[^"]*">CBC-1<\/bdi>/);
    // None of the English texts of the Orders dictionary is left on the Arabic page.
    const english = (value: unknown): string[] => typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(english) : value && typeof value === "object" ? Object.values(value).flatMap(english) : [];
    const leftover = english(messages.en.work.orders).filter((text) => text.length > 8 && visible(html).includes(text));
    expect(leftover).toEqual([]);
    // No sentence of English is left once the data is taken out: the catalog's names and doses, the physician's words, the hospital's rule, the chart's entries, the assistant's reason.
    let rest = visible(html).replace(ISOLATES, "");
    const data = [draft.request, ORDER_CATALOG.interactions[0].text, "a kidney scan", "A fictional reason.", "Reaction: urticaria", "5 mg once daily", "every 8 hours", "once daily", "7 days", "urn:test",
      ...ORDER_CATALOG.items.flatMap((item) => [item.display, ...(item.medication ? Object.values(item.medication) : [])]), ...ORDER_FACTS.map((fact) => fact.label), ...draft.lines.map((entry) => entry.requestedText ?? "")];
    for (const text of data.sort((a, b) => b.length - a.length)) rest = rest.split(text).join(" ");
    expect(ENGLISH_SENTENCE.test(rest), rest).toBe(false);
    expect(visible(html).split(" ").filter((word) => ARABIC.test(word)).length).toBeGreaterThan(40);
  });

  it("is a drafts-only page for anyone who may not approve: no decision control, and it says a physician must approve", async () => {
    const draft = await specific();
    const nurse: OrderAccess = { draft: true, approve: false, write: false };
    const html = inLocale("en", createElement(OrderReviewLoaded, { draft, access: nurse, onDraft: () => undefined, onReload: () => undefined }));
    expect(html).not.toContain("aria-pressed");
    expect(visible(html)).not.toContain("Record my decisions");
    expect(visible(html)).toContain("A physician must approve these orders before they can be entered in the chart.");
    const arabic = inLocale("ar", createElement(OrderReviewLoaded, { draft, access: nurse, onDraft: () => undefined, onReload: () => undefined }));
    expect(visible(arabic)).toContain("يجب أن يعتمد الطبيب هذه الأوامر");
  });

  it("offers a physician approve and reject on each pending order, and the record button", async () => {
    const draft = await specific();
    const access: OrderAccess = { draft: true, approve: true, write: true };
    const html = inLocale("en", createElement(OrderReviewLoaded, { draft, access, onDraft: () => undefined, onReload: () => undefined }));
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(draft.lines.length * 2);
    for (const text of ["Your decision", "Record my decisions", "Approving does not write anything to the EHR.", "Choose approve or reject for at least one order."]) expect(visible(html), text).toContain(text);
    const arabic = visible(inLocale("ar", createElement(OrderReviewLoaded, { draft, access, onDraft: () => undefined, onReload: () => undefined })));
    for (const text of ["قرارك", "تسجيل قراراتي", "اعتماد", "رفض"]) expect(arabic, text).toContain(text);
  });

  it("asks for the acknowledgement and the reason on an approval that needs them, and on no other", async () => {
    const draft = await specific();
    const facts = factsOf(draft);
    const amox = draft.lines.find((entry) => entry.catalogItemId === "med-amox")!;
    const cbc = draft.lines.find((entry) => entry.catalogItemId === "lab-cbc")!;
    const card = (entry: OrderDraft["lines"][number], choice: LineChoice, locale: "en" | "ar" = "en") => inLocale(locale, createElement(OrderLineCard, { line: entry, facts, choice, onChoice: () => undefined }));
    const needs = card(amox, { choice: "approve", acknowledged: [], reason: "" });
    for (const text of ["Your acknowledgement is needed to approve", "I have read the allergy warning and I am ordering this on purpose.", "Why you are ordering it anyway", `At least ${MIN_OVERRIDE_REASON} characters.`]) expect(visible(needs), text).toContain(text);
    expect(needs).toContain('type="checkbox"');
    expect(needs).toContain('maxLength="500"');
    expect(card(amox, { choice: "reject", acknowledged: [], reason: "" })).not.toContain("type=\"checkbox\"");
    expect(card(cbc, { choice: "approve", acknowledged: [], reason: "" })).not.toContain("type=\"checkbox\"");
    expect(visible(card(amox, { choice: "approve", acknowledged: ["allergy"], reason: "" }, "ar"))).toContain("يلزم إقرارك لاعتماد هذا الأمر");
  });

  it("shows a decided order with what was decided, the acknowledgement and the reason, and no decision control", async () => {
    const draft = await specific();
    const amox = draft.lines.find((entry) => entry.catalogItemId === "med-amox")!;
    const decided = { ...amox, status: "approved" as const, decidedBy: physician.clinicianId, decidedAt: "2026-03-10T08:00:00.000Z", acknowledged: ["allergy" as const], overrideReason: "Reviewed with the patient; no reaction history." };
    const html = inLocale("en", createElement(OrderLineCard, { line: decided, facts: factsOf(draft), onChoice: () => undefined }));
    expect(html).not.toContain("aria-pressed");
    for (const text of ["Approved", "You acknowledged: Allergy", "Your reason:", "Reviewed with the patient; no reaction history."]) expect(visible(html), text).toContain(text);
    expect(visible(inLocale("ar", createElement(OrderLineCard, { line: decided, facts: factsOf(draft) })))).toContain("أقررتَ بالاطلاع على: حساسية");
  });
});

describe("approved orders and the chart", () => {
  const approvedDraft = async () => {
    const draft = await specific();
    const cbc = draft.lines.find((entry) => entry.catalogItemId === "lab-cbc")!;
    const amox = draft.lines.find((entry) => entry.catalogItemId === "med-amox")!;
    const lines = draft.lines.map((entry) => ([cbc.id, amox.id].includes(entry.id) ? { ...entry, status: "approved" as const, decidedBy: physician.clinicianId, decidedAt: "2026-03-10T08:00:00.000Z" } : entry));
    return { draft: { ...draft, lines, version: 2 }, cbc: lines.find((entry) => entry.id === cbc.id)!, amox: lines.find((entry) => entry.id === amox.id)! };
  };
  const result = (entry: OrderDraft["lines"][number], status: ChartWriteResult["status"], extra: Partial<ChartWriteResult> = {}): ChartWriteResult =>
    ({ itemKey: `sl-ord-${entry.id.replaceAll("-", "")}`, item: entry.id, resourceType: entry.kind === "medication" ? "MedicationRequest" : "ServiceRequest", status, ...(status === "created" || status === "existing" ? {} : { copyText: orderCopyText(entry) }), ...extra });

  it("says plainly that the EHR cannot receive the order and shows the text to enter and to copy, in both languages", async () => {
    const { draft, cbc, amox } = await approvedDraft();
    const results = [result(cbc, "unsupported", { failure: "The EHR does not accept new ServiceRequest records from applications" }), result(amox, "unsupported")];
    const english = inLocale("en", createElement(OrderChartView, { draft, canWrite: true, results }));
    for (const text of ["In the patient's chart", "Your EHR cannot receive these orders", "Enter each order in the EHR yourself", "Not written: your EHR cannot receive it", "Text to enter:",
      "Laboratory: Complete blood count (CBC-1, urn:test)", "Medication: Amoxicillin, 500 mg, oral, every 8 hours, 7 days", "Copy text", "Copy all as text"]) expect(visible(english), text).toContain(text);
    expect(english).toContain('dir="ltr"');
    const arabic = visible(inLocale("ar", createElement(OrderChartView, { draft, canWrite: true, results })));
    for (const text of ["في ملف المريض", "لا يستطيع نظامك الطبي استقبال هذه الأوامر", "أدخل كل أمر في النظام الطبي بنفسك", "نسخ النص", "نسخ الكل كنص", "Laboratory: Complete blood count (CBC-1, urn:test)"]) expect(arabic, text).toContain(text);
    // The server's English explanation of an "unsupported" order is not shown: the screen says it in its own words.
    expect(arabic).not.toContain("does not accept new ServiceRequest");
  });

  it("offers the write to a physician with the write scope only, and shows an order in the chart as done", async () => {
    const { draft, cbc, amox } = await approvedDraft();
    const pending = [result(cbc, "pending"), result(amox, "pending")];
    const physicianView = visible(inLocale("en", createElement(OrderChartView, { draft, canWrite: true, results: pending })));
    expect(physicianView).toContain("Write approved orders to the chart");
    expect(physicianView).toContain("Not written yet");
    expect(physicianView).not.toContain("Text to enter:");   // before a write is tried, only a copy button is offered
    const reader = visible(inLocale("en", createElement(OrderChartView, { draft, canWrite: false, results: pending })));
    expect(reader).not.toContain("Write approved orders to the chart");
    expect(reader).toContain("Only a physician can write approved orders to the chart.");
    const done = visible(inLocale("en", createElement(OrderChartView, { draft, canWrite: true, results: [result(cbc, "created", { resourceId: "ServiceRequest/1" }), result(amox, "existing")] })));
    expect(done).toContain("In the chart");
    expect(done).not.toContain("Write approved orders to the chart");
    expect(done).not.toContain("Cannot receive");
  });

  it("shows a failed write with what to do, and a draft with nothing approved shows no panel", async () => {
    const { draft, cbc, amox } = await approvedDraft();
    const failed = visible(inLocale("en", createElement(OrderChartView, { draft, canWrite: true, results: [result(cbc, "failed", { failure: "HTTP 500" }), result(amox, "created")] })));
    for (const text of ["The EHR did not take this order and nothing was changed in the chart.", "Details from the server:", "HTTP 500", "Not written"]) expect(failed, text).toContain(text);
    expect(inLocale("en", createElement(OrderChartView, { draft: await specific(), canWrite: true, results: [] }))).toBe("");
    // While the statuses load and when they could not be loaded.
    expect(visible(inLocale("ar", createElement(OrderChartView, { draft, canWrite: true })))).toContain("جارٍ تحميل حالة الملف");
    expect(visible(inLocale("en", createElement(OrderChartView, { draft, canWrite: true, error: "The chart status could not be loaded. Try again.", onRetry: () => undefined })))).toContain("Retry");
  });
});
