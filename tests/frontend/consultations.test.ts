import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApiClientError } from "@/shared/api-client";
import type { ConsultationDraft } from "@/shared/contracts";
import { syntheticDrafts } from "@/shared/mocks/synthetic-data";
import {
  canReview,
  ConsultationDraftView,
  ConsultationReview,
  DECISIONS_REQUIRING_COMMENT,
  describeDecisionError,
} from "@/features/consultations";

// vitest.config.ts compiles JSX in classic mode; expose React until a jsdom/React test setup lands.
(globalThis as { React?: typeof React }).React = React;

const pending: ConsultationDraft = { ...syntheticDrafts[0]! };
const render = (props: Partial<Parameters<typeof ConsultationDraftView>[0]> = {}) =>
  renderToStaticMarkup(createElement(ConsultationDraftView, { draft: pending, onDecide: vi.fn(), ...props }));

describe("consultation review rules", () => {
  it("only allows review while pending or sent back", () => {
    expect(canReview(pending)).toBe(true);
    expect(canReview({ ...pending, status: "draft" })).toBe(true);
    expect(canReview({ ...pending, status: "approved" })).toBe(false);
    expect(canReview({ ...pending, status: "rejected" })).toBe(false);
  });

  it("requires a comment for reject and request changes, not approve", () => {
    expect(DECISIONS_REQUIRING_COMMENT.has("reject")).toBe(true);
    expect(DECISIONS_REQUIRING_COMMENT.has("request_changes")).toBe(true);
    expect(DECISIONS_REQUIRING_COMMENT.has("approve")).toBe(false);
  });

  it("explains conflict and auth errors", () => {
    expect(describeDecisionError(new ApiClientError("conflict", "x", 409))).toMatch(/already reviewed/);
    expect(describeDecisionError(new ApiClientError("forbidden", "x", 403))).toMatch(/not allowed/);
    expect(describeDecisionError(new Error("boom"))).toMatch(/Try again/);
  });
});

describe("ConsultationDraftView", () => {
  it("labels output as AI-generated and needing review", () => {
    const html = render();
    expect(html).toContain("AI-generated");
    expect(html).toMatch(/not part of the record until a clinician reviews/);
    expect(html).toContain("Awaiting your review");
    expect(html).toContain(pending.plan[0]);
  });

  it("never approves in one click: Approve opens a confirmation step", () => {
    expect(render()).toContain("Approve…");
    expect(render()).not.toContain("Confirm approval");
    expect(render({ initialPendingDecision: "approve" })).toContain("Confirm approval");
  });

  it("disables reject and request changes until a comment is written", () => {
    const html = render();
    expect(html).toMatch(/disabled=""[^>]*>Request changes/);
    expect(html).toMatch(/disabled=""[^>]*>Reject/);
  });

  it("shows the server-provided reviewer and hides controls once decided", () => {
    const html = render({
      draft: { ...pending, status: "approved", reviewedBy: "dr-synthetic", reviewedAt: "2026-01-15T10:00:00.000Z" },
    });
    expect(html).toContain("Reviewed by");
    expect(html).toContain("dr-synthetic");
    expect(html).toContain('dateTime="2026-01-15T10:00:00.000Z"');
    expect(html).not.toContain("Approve…");
    expect(html).toContain("No further action");
  });

  it("announces submit errors with a reload action", () => {
    const html = render({ submitError: "This draft was already reviewed.", onReload: vi.fn() });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Reload draft");
  });

  it("marks itself busy while submitting", () => {
    expect(render({ submitting: "reject" })).toContain('aria-busy="true"');
  });

  it("shows an empty plan explicitly", () => {
    expect(render({ draft: { ...pending, plan: [] } })).toContain("No plan items");
  });
});

describe("ConsultationReview", () => {
  it("renders a loading skeleton first", () => {
    const html = renderToStaticMarkup(createElement(ConsultationReview, { draftId: "syn-draft-001" }));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Loading consultation draft");
  });
});
