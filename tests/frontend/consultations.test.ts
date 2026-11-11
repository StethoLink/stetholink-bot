import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ApprovalControls,
  ConsultationDraftView,
  createDraft,
  decideDraft,
  draftReducer,
  initialDraftState,
  loadDraft,
  type DraftAction,
  type DraftState,
} from "@/apps/embedded-app/features/consultations";
import { createMockApiClient } from "@/shared/api-client";

// Mock CSS imports in the logic tests.
// Vitest compiles JSX with the classic runtime until esbuild.jsx is set to "automatic".
(globalThis as { React?: typeof React }).React = React;
vi.mock("@/apps/embedded-app/features/consultations/styles/approval.module.css", () => ({ default: {} }));


function harness() {
  let state: DraftState = initialDraftState;
  const dispatch = (a: DraftAction) => {
    state = draftReducer(state, a);
  };
  return { dispatch, get: () => state };
}

const ready = (s: DraftState) => {
  if (s.status !== "ready") throw new Error(`expected ready, got ${s.status}`);
  return s;
};

describe("consultation draft state", () => {
  it("loads an existing draft", async () => {
    const h = harness();
    await loadDraft(createMockApiClient(), h.dispatch, "syn-draft-001");
    expect(ready(h.get()).draft.status).toBe("pending_approval");
  });

  it("shows a load error for an unknown draft", async () => {
    const h = harness();
    await loadDraft(createMockApiClient(), h.dispatch, "missing");
    expect(h.get()).toEqual({ status: "error", error: "Draft not found" });
  });

  it("generates a new draft pending approval", async () => {
    const h = harness();
    const d = await createDraft(createMockApiClient(), h.dispatch, { patientId: "syn-pt-001" });
    expect(d?.status).toBe("pending_approval");
    expect(ready(h.get()).draft.id).toBe(d?.id);
  });

  it.each([
    ["approve", "approved"],
    ["reject", "rejected"],
    ["request_changes", "draft"],
  ] as const)("%s sets status %s and records the reviewer", async (decision, status) => {
    const client = createMockApiClient();
    const h = harness();
    await loadDraft(client, h.dispatch, "syn-draft-001");
    await decideDraft(client, h.dispatch, { draftId: "syn-draft-001", decision, comment: "c" });
    const s = ready(h.get());
    expect(s.draft.status).toBe(status);
    expect(s.draft.reviewedBy).toBeDefined();
    expect(s.draft.reviewedAt).toBeDefined();
    expect(s.submitting).toBe(false);
  });

  it("keeps the draft and surfaces the error when a second approval conflicts", async () => {
    const client = createMockApiClient();
    const h = harness();
    await loadDraft(client, h.dispatch, "syn-draft-001");
    await decideDraft(client, h.dispatch, { draftId: "syn-draft-001", decision: "approve" });
    await decideDraft(client, h.dispatch, { draftId: "syn-draft-001", decision: "approve" });
    const s = ready(h.get());
    expect(s.draft.status).toBe("approved");
    expect(s.submitError).toBe("Draft is already approved");
  });
});

describe("consultation components", () => {
  const draft = {
    id: "d1",
    patientId: "syn-pt-001",
    status: "approved" as const,
    summary: "S",
    assessment: "A",
    plan: ["P1"],
    generatedBy: "ai" as const,
    createdAt: "2026-11-09T00:00:00.000Z",
    updatedAt: "2026-11-09T00:00:00.000Z",
    reviewedBy: "dr-x",
    reviewedAt: "2026-11-09T01:00:00.000Z",
  };

  it("labels the draft as AI-generated and shows the reviewer", () => {
    const html = renderToStaticMarkup(createElement(ConsultationDraftView, { draft }));
    expect(html).toContain("AI-generated");
    expect(html).toContain("Status: Approved");
    expect(html).toContain("Reviewed by dr-x");
  });

  it("offers three separate decision buttons while pending", () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalControls, { status: "pending_approval", submitting: false, onDecide: () => {} }),
    );
    for (const label of ["Approve", "Reject", "Request changes"]) expect(html).toContain(`>${label}</button>`);
  });

  it("hides decision buttons once a final decision exists", () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalControls, { status: "approved", submitting: false, onDecide: () => {} }),
    );
    expect(html).not.toContain("<button");
    expect(html).toContain("decision has been recorded");
  });
});

import { awaitingProvider, describeDelivery } from "@/apps/embedded-app/features/consultations";
import type { ConsultationDeliveryView } from "@/shared/contracts";

describe("delivery status wording", () => {
  const view = (status: ConsultationDeliveryView["status"], failureCode?: ConsultationDeliveryView["attempts"][number]["failureCode"]): ConsultationDeliveryView => ({
    draftId: "d", version: 3, status, provider: null, responses: [], report: null, canSend: false, canRetry: false, canSimulate: false,
    attempts: failureCode ? [{ requestId: "8d5f6f0e-6f0e-4d7c-9b65-0f7a4f0f5a11", number: 1, providerId: "p", status: failureCode === "provider_rejected" ? "rejected" : "failed",
      failureCode, createdAt: "2026-01-15T10:00:00.000Z", updatedAt: "2026-01-15T10:00:00.000Z" }] : [],
  });

  it("states the delivery state and an actionable reason for each failure", () => {
    expect(describeDelivery(view("approved"))).toEqual({ state: "Approved. Not sent yet.", problem: undefined });
    expect(describeDelivery(view("responded")).state).toBe("The specialist has responded.");
    expect(describeDelivery(view("failed", "transport_error")).problem).toMatch(/retry/i);
    expect(describeDelivery(view("failed", "transport_timeout")).problem).toMatch(/late reply/i);
    expect(describeDelivery(view("failed", "provider_rejected")).problem).toMatch(/declined/i);
  });

  it("keeps checking only while a provider reply is outstanding", () => {
    expect(["queued", "sent", "accepted"].every((status) => awaitingProvider(view(status as ConsultationDeliveryView["status"])))).toBe(true);
    expect(["approved", "responded", "failed", "cancelled"].some((status) => awaitingProvider(view(status as ConsultationDeliveryView["status"])))).toBe(false);
    expect(awaitingProvider(null)).toBe(false);
  });
});
