"use client";

import { useId, useState } from "react";
import type { ApprovalDecision, ConsultationDraft, ConsultationStatus } from "@/shared/contracts";
import { canReview } from "../hooks/useConsultationDraft";

const STATUS_LABEL: Record<ConsultationStatus, string> = {
  draft: "Changes requested",
  pending_approval: "Awaiting your review",
  approved: "Approved",
  rejected: "Rejected",
  archived: "Archived",
};

// Text label is always shown alongside colour, so meaning never relies on colour alone.
const STATUS_STYLE: Record<ConsultationStatus, string> = {
  draft: "border-amber-700 bg-amber-50 text-amber-900",
  pending_approval: "border-sky-800 bg-sky-50 text-sky-900",
  approved: "border-emerald-800 bg-emerald-50 text-emerald-900",
  rejected: "border-red-800 bg-red-50 text-red-900",
  archived: "border-slate-600 bg-slate-50 text-slate-800",
};

const DECISION_VERB: Record<ApprovalDecision, string> = {
  approve: "approved",
  reject: "rejected",
  request_changes: "sent back for changes",
};

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export interface ConsultationDraftViewProps {
  draft: ConsultationDraft;
  submitting?: ApprovalDecision;
  submitError?: string;
  onDecide: (decision: ApprovalDecision, comment?: string) => Promise<boolean> | void;
  onReload?: () => void;
  /** Starts in the approval confirmation step (for tests and previews). */
  initialPendingDecision?: ApprovalDecision;
}

/** Presentational review panel for an AI-generated consultation draft. */
export function ConsultationDraftView({
  draft,
  submitting,
  submitError,
  onDecide,
  onReload,
  initialPendingDecision,
}: ConsultationDraftViewProps) {
  const baseId = useId();
  const [comment, setComment] = useState("");
  const [pending, setPending] = useState<ApprovalDecision | undefined>(initialPendingDecision);
  const [lastDecision, setLastDecision] = useState<ApprovalDecision>();
  const reviewable = canReview(draft);
  const busy = submitting !== undefined;

  async function submit(decision: ApprovalDecision) {
    const ok = await onDecide(decision, comment);
    if (ok !== false) {
      setPending(undefined);
      setComment("");
      setLastDecision(decision);
    }
  }

  const titleId = `${baseId}-title`;
  const commentId = `${baseId}-comment`;
  const commentHintId = `${baseId}-comment-hint`;

  return (
    <article
      aria-labelledby={titleId}
      aria-busy={busy || undefined}
      className="rounded-lg border border-slate-200 bg-white p-4 text-slate-900"
    >
      <header className="flex flex-wrap items-center gap-2">
        <h2 id={titleId} className="text-lg font-semibold">
          Consultation draft
        </h2>
        <span
          className="rounded border border-violet-800 bg-violet-50 px-2 py-0.5 text-xs font-semibold text-violet-900"
          data-testid="ai-badge"
        >
          AI-generated
        </span>
        <span
          className={`rounded border px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[draft.status]}`}
          data-testid="status-badge"
        >
          Status: {STATUS_LABEL[draft.status]}
        </span>
      </header>

      <p className="mt-2 rounded border-l-4 border-amber-700 bg-amber-50 px-3 py-2 text-sm text-amber-950">
        Drafted by AI. It is not part of the record until a clinician reviews and approves it. Check every statement
        against the chart.
      </p>

      <dl className="mt-3 space-y-3 text-sm">
        <div>
          <dt className="font-semibold">Summary</dt>
          <dd className="mt-0.5 whitespace-pre-wrap">{draft.summary}</dd>
        </div>
        <div>
          <dt className="font-semibold">Assessment</dt>
          <dd className="mt-0.5 whitespace-pre-wrap">{draft.assessment}</dd>
        </div>
        <div>
          <dt className="font-semibold">Plan</dt>
          <dd className="mt-0.5">
            {draft.plan.length ? (
              <ol className="list-decimal space-y-0.5 pl-5">
                {draft.plan.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ol>
            ) : (
              <span className="italic text-slate-700">No plan items in this draft.</span>
            )}
          </dd>
        </div>
      </dl>

      <p className="mt-3 text-xs text-slate-700">
        Generated {formatDateTime(draft.createdAt)}
        {draft.updatedAt !== draft.createdAt && <> · Updated {formatDateTime(draft.updatedAt)}</>}
      </p>

      {draft.reviewedBy && draft.reviewedAt && (
        <p className="mt-2 text-sm" data-testid="review-record">
          <span className="font-semibold">Reviewed by</span> {draft.reviewedBy} on{" "}
          <time dateTime={draft.reviewedAt}>{formatDateTime(draft.reviewedAt)}</time>
        </p>
      )}

      <div aria-live="polite" className="sr-only">
        {lastDecision && `Draft ${DECISION_VERB[lastDecision]}.`}
      </div>

      {submitError && (
        <div role="alert" className="mt-3 rounded border border-red-800 bg-red-50 px-3 py-2 text-sm text-red-900">
          {submitError}
          {onReload && (
            <button
              type="button"
              onClick={onReload}
              className="ml-2 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-900"
            >
              Reload draft
            </button>
          )}
        </div>
      )}

      {reviewable ? (
        <section aria-label="Clinician decision" className="mt-4 border-t border-slate-200 pt-3">
          <label htmlFor={commentId} className="block text-sm font-semibold">
            Comment
          </label>
          <p id={commentHintId} className="text-xs text-slate-700">
            Required to reject or request changes. Optional for approval.
          </p>
          <textarea
            id={commentId}
            aria-describedby={commentHintId}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            disabled={busy}
            rows={2}
            className="mt-1 w-full rounded border border-slate-400 p-2 text-sm focus-visible:outline-2 focus-visible:outline-sky-800"
          />

          {pending === "approve" ? (
            <div
              role="group"
              aria-label="Confirm approval"
              className="mt-2 rounded border border-emerald-800 bg-emerald-50 p-3 text-sm"
            >
              <p className="font-semibold text-emerald-950">
                Approve this AI-generated draft? You confirm you have reviewed it and accept it under your name.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void submit("approve")}
                  disabled={busy}
                  className={btn("bg-emerald-800 text-white")}
                >
                  {submitting === "approve" ? "Approving…" : "Confirm approval"}
                </button>
                <button
                  type="button"
                  onClick={() => setPending(undefined)}
                  disabled={busy}
                  className={btn("border border-slate-500 bg-white text-slate-900")}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setPending("approve")}
                disabled={busy}
                className={btn("bg-emerald-800 text-white")}
              >
                Approve…
              </button>
              <button
                type="button"
                onClick={() => void submit("request_changes")}
                disabled={busy || !comment.trim()}
                className={btn("border border-amber-800 bg-white text-amber-900")}
              >
                {submitting === "request_changes" ? "Sending…" : "Request changes"}
              </button>
              <button
                type="button"
                onClick={() => void submit("reject")}
                disabled={busy || !comment.trim()}
                className={btn("border border-red-800 bg-white text-red-900")}
              >
                {submitting === "reject" ? "Rejecting…" : "Reject"}
              </button>
            </div>
          )}
          {!comment.trim() && pending !== "approve" && (
            <p className="mt-1 text-xs text-slate-700">Add a comment to enable Reject and Request changes.</p>
          )}
        </section>
      ) : (
        <p className="mt-4 border-t border-slate-200 pt-3 text-sm text-slate-800">
          No further action: this draft is {STATUS_LABEL[draft.status].toLowerCase()}.
        </p>
      )}
    </article>
  );
}

function btn(variant: string) {
  return `rounded px-3 py-1.5 text-sm font-semibold motion-safe:transition-opacity disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-800 ${variant}`;
}
