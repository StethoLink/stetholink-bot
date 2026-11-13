import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApprovalControls, ConsultationDraftView, StatusTracker, consultationTracker } from "@/apps/embedded-app/features/consultations";
import { mockProvider } from "@/core/agent/providers/mock-provider";
import { clinicalSafetyGuard } from "@/core/agent/safety/guard";
import { createConsultationService } from "@/core/consultation/service";
import { syntheticClinicalAdapter } from "@/integrations/mock/connector";
import type { ConsultationDraft } from "@/shared/contracts";
import { citedEvidenceIds, parseReferralText, parseStatement, renderStatement } from "@/shared/utils/referral-text";

(globalThis as { React?: typeof React }).React = React;
vi.mock("@/apps/embedded-app/features/consultations/styles/approval.module.css", () => ({ default: {} }));

const REQUEST = "Prepare a cardiology consultation for this patient regarding possible acute coronary syndrome.";
async function authoredDraft(): Promise<ConsultationDraft> {
  const service = createConsultationService({
    repository: { get: vi.fn(), approve: vi.fn(), create: vi.fn(async (draft) => draft) },
    provider: mockProvider, safety: clinicalSafetyGuard, dataClassification: "synthetic", adapter: syntheticClinicalAdapter, specialties: ["Cardiology"],
  });
  return service.author({ patientId: "syn-pt-omar", encounterId: "syn-enc-omar" }, REQUEST);
}
const html = (draft: ConsultationDraft) => renderToStaticMarkup(createElement(ConsultationDraftView, { draft }));
const steps = (...args: Parameters<typeof consultationTracker>) => consultationTracker(...args).steps.map((step) => `${step.label}:${step.state}`).join(" ");

describe("consultation text format", () => {
  it("round-trips statements and their citations, including the legacy citation form", () => {
    const statement = { text: "Blood pressure 148/92 mmHg", evidenceIds: ["omar-bp", "omar-hr"] };
    expect(parseStatement(renderStatement(statement))).toEqual(statement);
    expect(parseStatement("- ECG: unknown [ahmed-ecg; synthetic-case-ahmed-v1; documented 2026-01-15T10:00:00.000Z]")).toEqual({ text: "ECG: unknown", evidenceIds: ["ahmed-ecg"] });
    expect(parseStatement("A physician's own line")).toEqual({ text: "A physician's own line", evidenceIds: [] });
  });

  it("keeps free text a physician typed instead of hiding it", () => {
    const parsed = parseReferralText("Consultation request: Cardiology\nClinical question: Why?\nAvailable investigations:\n- ECG shows ST depression [omar-ecg]\n- Added by hand\nPresenting symptoms:\n- Nothing from the chart was included.");
    expect(parsed.header).toEqual([{ label: "Consultation request", value: "Cardiology" }, { label: "Clinical question", value: "Why?" }]);
    expect(parsed.sections[0].statements).toEqual([{ text: "ECG shows ST depression", evidenceIds: ["omar-ecg"] }, { text: "Added by hand", evidenceIds: [] }]);
    expect(parsed.sections[1].statements).toEqual([]);
    expect(citedEvidenceIds("- a [x]\n- b [y] [x]")).toEqual(["x", "y"]);
  });
});

describe("consultation draft view", () => {
  it("separates documented findings with sources, missing information and AI suggestions", async () => {
    const draft = await authoredDraft();
    const page = html(draft);
    expect(page).toContain("Cardiology consultation request");
    expect(page).toContain(REQUEST);
    for (const heading of ["Documented findings", "Missing information", "AI suggestions", "Source evidence", "Clinical question"]) expect(page).toContain(heading);
    expect(page).toContain(`href="#source-${draft.id}-omar-ecg"`);
    expect(page).toContain(`id="source-${draft.id}-omar-ecg"`);
    expect(page).toContain("synthetic-case-omar-v1");
    expect(page).toContain("Echocardiogram: not performed");
    expect(page).toContain("Not available does not mean normal or not done.");
    expect(page).not.toContain("No chart source");
  });

  it("never presents the deterministic fallback as AI, and shows model provenance for a live draft", async () => {
    const draft = await authoredDraft();
    const fallback = html(draft);
    expect(fallback).toContain("Demo fallback, not AI.");
    expect(fallback).not.toContain(">AI-generated<");
    const live = html({ ...draft, grounding: { ...draft.grounding!, provenance: { ...draft.grounding!.provenance, provider: "openai", model: "model-x" },
      authoring: { ...draft.grounding!.authoring!, liveInference: true, rejectedStatements: 2, usage: { inputTokens: 1200, outputTokens: 300, estimatedCostUsd: 0.0123, latencyMs: 4200, attempts: 1 } } } });
    expect(live).toContain(">AI-generated<");
    expect(live).toMatch(/Drafted by openai model <span[^>]*>model-x<\/span> · 1500 tokens · est\. \$0\.0123 · 4\.2 s/);
    expect(live).toContain("2 statements were removed");
    expect(live).not.toContain("Demo fallback");
  });

  it("flags a hand-edited line that cites nothing and a citation that matches no chart fact", async () => {
    const draft = await authoredDraft();
    const edited = html({ ...draft, summary: draft.summary + "\n- Patient appears comfortable\n- Old result [not-a-fact]" });
    expect(edited).toContain("No chart source");
    expect(edited).toContain("Unknown source not-a-fact");
    const shorter = html({ ...draft, summary: "Consultation request: Cardiology\nAvailable investigations:\n- 12-lead ECG shows ST depression [omar-ecg]" });
    expect(shorter).toMatch(/15 not used in this draft/);
  });
});

describe("status tracking from stored state", () => {
  it("follows the server status through the normal path", () => {
    expect(steps("pending_review")).toBe("Prepared:current Approved:upcoming Sending:upcoming Delivered:upcoming Accepted:upcoming Responded:upcoming");
    expect(steps("approved")).toMatch(/^Prepared:done Approved:current Sending:upcoming/);
    expect(steps("queued", "queued")).toMatch(/Approved:done Sending:current Delivered:upcoming/);
    expect(steps("sent", "sent")).toMatch(/Sending:done Delivered:current Accepted:upcoming/);
    expect(steps("accepted", "accepted")).toMatch(/Delivered:done Accepted:current Responded:upcoming/);
    expect(steps("responded", "responded")).not.toMatch(/current|upcoming/);
  });

  it("shows failure, decline, rejection and cancellation without claiming unproven steps", () => {
    expect(consultationTracker("failed", "failed")).toMatchObject({ stopped: { label: "Not delivered" } });
    expect(steps("failed", "failed")).toMatch(/^Prepared:done Approved:done Sending:upcoming Delivered:upcoming/);
    expect(consultationTracker("failed", "rejected")).toMatchObject({ stopped: { label: "Declined" } });
    expect(steps("failed", "rejected")).toMatch(/Delivered:done Accepted:upcoming/);
    expect(consultationTracker("rejected").stopped?.label).toBe("Rejected");
    expect(steps("rejected")).toMatch(/^Prepared:done Approved:upcoming/);
    expect(steps("cancelled")).toMatch(/^Prepared:done Approved:upcoming/);
    const markup = renderToStaticMarkup(createElement(StatusTracker, { status: "failed", latestAttempt: "rejected" }));
    expect(markup).toContain("The provider declined this consultation.");
    expect(markup).not.toContain('aria-current="step"');
  });
});

describe("approval destinations", () => {
  const render = (props: Partial<Parameters<typeof ApprovalControls>[0]>) =>
    renderToStaticMarkup(createElement(ApprovalControls, { status: "pending_approval", submitting: false, onDecide: () => {}, ...props }));

  it("cannot approve without an allowed destination, and does not say so while they are loading", () => {
    expect(render({ destinations: [] })).toContain("No allowed provider offers the requested specialty");
    expect(render({ destinations: [] })).toMatch(/<button[^>]*disabled=""[^>]*>Approve<\/button>/);
    expect(render({ destinations: [], destinationsLoading: true })).not.toContain("No allowed provider");
    expect(render({ destinations: [{ id: "synthetic-cardiology", displayName: "Synthetic Cardiology Consult Service", synthetic: true }] })).not.toMatch(/disabled=""[^>]*>Approve</);
  });
});
