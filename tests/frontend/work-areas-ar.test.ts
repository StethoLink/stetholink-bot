import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as React from "react";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApprovalControls, ConsultationComposer, ConsultationDraftView, DraftStatusBadge, StatusTracker, consultationTracker, describeDelivery } from "@/apps/embedded-app/features/consultations";
import { describeFailure } from "@/apps/embedded-app/features/consultations/hooks/deliveryState";
import { LocaleProvider } from "@/apps/embedded-app/i18n/client";
import { messages } from "@/apps/embedded-app/i18n/messages";
import { clinicalSafetyGuard } from "@/core/agent/safety/guard";
import { createConsultationService } from "@/core/consultation/service";
import type { ConsultationDeliveryView, ConsultationDraft, ConsultationStatus } from "@/shared/contracts";
import { drafted } from "@/tests/helpers/drafted";
import { syntheticClinicalAdapter } from "@/tests/fixtures/clinical-adapter";
import { mockProvider } from "@/tests/fixtures/mock-provider";

(globalThis as { React?: typeof React }).React = React;
vi.mock("@/apps/embedded-app/features/consultations/styles/approval.module.css", () => ({ default: {} }));

const root = join(import.meta.dirname, "../..");
const inArabic = (node: ReactElement) => renderToStaticMarkup(createElement(LocaleProvider, { locale: "ar" }, node));
/** The words a person reads, without markup. */
const visible = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&[a-z#0-9]+;/g, " ").replace(/\s+/g, " ");
/** A run of three English words: what a sentence left untranslated looks like. */
const ENGLISH_SENTENCE = /\b[A-Za-z]{2,}(?:'[a-z]+)?\s+[A-Za-z]{2,}\s+[A-Za-z]{2,}\b/;

const REQUEST = "Prepare a cardiology consultation for this patient regarding possible acute coronary syndrome.";
async function authoredDraft(): Promise<ConsultationDraft> {
  const service = createConsultationService({
    repository: { get: vi.fn(), approve: vi.fn(), create: vi.fn(async (draft) => draft) },
    provider: mockProvider, safety: clinicalSafetyGuard, dataClassification: "synthetic", adapter: syntheticClinicalAdapter, specialties: ["Cardiology"],
  });
  return drafted(service.author({ patientId: "syn-pt-omar", encounterId: "syn-enc-omar" }, REQUEST));
}

describe("the consultation panel in Arabic", () => {
  it("writes the draft view's own words in Arabic and leaves what the model and the chart wrote as written", async () => {
    const draft = await authoredDraft();
    const page = inArabic(createElement(ConsultationDraftView, { draft }));
    for (const heading of ["الموجودات الموثّقة", "معلومات ناقصة", "اقتراحات الذكاء الاصطناعي", "الأدلة المصدرية", "السؤال السريري", "طلبك"]) expect(page).toContain(heading);
    for (const english of ["Documented findings", "Missing information", "AI suggestions", "Source evidence", "Clinical question", "Your request", "Not available does not mean normal or not done."]) expect(page).not.toContain(english);
    // The request the physician typed and the specialty are data: unchanged, each with its own direction.
    expect(page).toContain(REQUEST);
    expect(page).toContain('dir="auto"');
    expect(page).toContain(`href="#source-${draft.id}-omar-ecg"`);
    // None of the English texts of this view's dictionary is left on the page (what the draft itself says is data and stays).
    const leftover = Object.values(messages.en.work.draft).flatMap((value) => typeof value === "string" ? [value] : typeof value === "object" ? Object.values(value) : [])
      .filter((text): text is string => typeof text === "string" && text.length > 8 && !/^[\s(]/.test(text)).filter((text) => visible(page).includes(text));
    expect(leftover).toEqual([]);
  });

  it("writes the approval dialog, the tracker, every status and the composer in Arabic", () => {
    const approval = inArabic(createElement(ApprovalControls, { status: "pending_review", submitting: false, destinations: [{ id: "d1", displayName: "Fictional Cardiology Service" }], onDecide: () => undefined }));
    expect(approval).toContain("قرار الممارس الصحي");
    for (const word of ["اعتماد", "رفض", "تعديل"]) expect(approval).toContain(`>${word}<`);
    expect(ENGLISH_SENTENCE.test(visible(approval).replace("Fictional Cardiology Service", ""))).toBe(false);

    const tracker = inArabic(createElement(StatusTracker, { status: "approved" }));
    for (const step of ["أُعدّت", "اعتُمدت", "قيد الإرسال", "سُلِّمت", "قُبلت", "تم الرد"]) expect(tracker).toContain(step);

    const statuses = Object.keys(messages.en.work.status) as ConsultationStatus[];
    for (const status of statuses) {
      const badge = visible(inArabic(createElement(DraftStatusBadge, { status })));
      expect(badge).toContain(messages.ar.work.status[status]);
      expect(/[A-Za-z]{3}/.test(badge)).toBe(false);
    }

    const composer = inArabic(createElement(ConsultationComposer, { patientId: "p", encounterId: "e", assistant: { provider: "openai", model: "gpt-5" } }));
    for (const text of ["مساعد الاستشارات", "ما الاستشارة التي تحتاجها؟", "إعداد الاستشارة", "اذكر التخصص وما تريد الإجابة عنه بكلماتك"]) expect(composer).toContain(text);
    for (const example of messages.ar.work.composer.examples) expect(composer).toContain(example);
    expect(composer).toContain("gpt-5");
  });

  it("explains a failed request in Arabic, not with the server's English", () => {
    for (const [status, error] of [[401], [503], [501, { code: "not_implemented", message: "Not configured" }], [409], [403, { code: "forbidden", message: "Access denied" }],
      [422, { code: "safety_blocked", message: "Blocked" }], [500], [404, { code: "not_found", message: "Draft not found" }]] as const) {
      const text = describeFailure(status, error, "ar");
      expect(text).toMatch(/[؀-ۿ]/);
      expect(text).not.toMatch(/Access denied|Draft not found|Blocked|Not configured/);
    }
    // A failure on the server's side carries the reference, which is read left to right and stays as it is.
    expect(describeFailure(500, { code: "internal_error", message: "x", requestId: "3FA9-01BC-77D2" }, "ar")).toContain("3FA9-01BC-77D2");
    // In English the server's own explanation is still used.
    expect(describeFailure(403, { code: "forbidden", message: "Access denied" }, "en")).toBe("Access denied");
  });

  it("describes where a consultation is in Arabic", () => {
    const ar = messages.ar.work;
    expect(consultationTracker("rejected", undefined, ar.tracker).stopped?.label).toBe("مرفوضة");
    expect(consultationTracker("failed", "rejected", ar.tracker).stopped?.label).toBe("اعتذرت الجهة");
    const view = (status: ConsultationDeliveryView["status"], failureCode?: string) => ({ status, attempts: failureCode ? [{ failureCode }] : [] }) as unknown as ConsultationDeliveryView;
    expect(describeDelivery(view("responded"), ar.delivery).state).toBe("ردّ الأخصائي.");
    expect(describeDelivery(view("failed", "transport_error"), ar.delivery).problem).toMatch(/[؀-ۿ]/);
    expect(describeDelivery(view("pending_approval" as ConsultationDeliveryView["status"]), ar.delivery).state).toBe(ar.delivery.state.fallback);
  });
});

describe("no English left in the work areas' source", () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : /\.tsx$/.test(path) ? [path] : [];
    });
  }
  const areas = ["consultations", "scribe", "specialist", "workspace", "ehr-panel", "orders"].map((name) => join(root, "apps/embedded-app/features", name));
  const sources = [...areas.flatMap(files), ...files(join(root, "apps/embedded-app/components/ui"))];

  /** Every piece of text a person reads that is written in a component instead of the dictionary. */
  function hardCoded(source: string): string[] {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/=>/g, "=_");
    const found: string[] = [];
    for (const match of code.matchAll(/\b(?:title|placeholder|aria-label|label|description|alt|confirmLabel|busyLabel|legend)="([^"{}]*)"/g)) found.push(match[1]);
    for (const match of code.matchAll(/>\s*([A-Z][a-z][^<>{}=;]*?)\s*</g)) found.push(match[1]);
    for (const match of code.matchAll(/^\s+([A-Z][a-z]+(?: [A-Za-z',.&;:!?-]+)*[.!?:]?)\s*$/gm)) found.push(match[1]);
    return found.filter((text) => /[A-Za-z]{3}/.test(text));
  }

  it("finds the components to check", () => {
    expect(sources.length).toBeGreaterThan(30);
  });

  it("writes every text a person reads in the dictionary, so both languages have it", () => {
    const hits = sources.flatMap((path) => hardCoded(readFileSync(path, "utf8")).map((text) => `${relative(root, path)}: ${text.slice(0, 60)}`));
    expect(hits).toEqual([]);
  });
});
