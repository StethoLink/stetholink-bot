"use client";

import type { StethoLinkApiClient } from "@/shared/api-client";
import { useConsultationDraft } from "../hooks/useConsultationDraft";
import { ApprovalControls } from "./ApprovalControls";
import { ConsultationDraftView } from "./ConsultationDraftView";

/** Loads a draft and lets the clinician review and decide on it. */
export function ConsultationReview({ draftId, client }: { draftId: string; client?: StethoLinkApiClient }) {
  const { state, reload, decide } = useConsultationDraft(draftId, { client });

  return (
    <section aria-label="Consultation review" className="rounded-lg border border-slate-200 bg-white p-4">
      {(state.status === "idle" || state.status === "loading") && (
        <div aria-busy="true" className="space-y-2">
          <span className="sr-only">Loading consultation draft…</span>
          <div className="h-5 w-1/3 animate-pulse rounded bg-slate-200 motion-reduce:animate-none" />
          <div className="h-16 animate-pulse rounded bg-slate-100 motion-reduce:animate-none" />
        </div>
      )}
      {state.status === "error" && (
        <div role="alert" className="space-y-2 text-sm text-red-800">
          <p>{state.error}</p>
          <button type="button" onClick={reload} className="rounded border border-current px-3 py-1 font-medium">
            Retry
          </button>
        </div>
      )}
      {state.status === "ready" && (
        <div className="space-y-4">
          <ConsultationDraftView draft={state.draft} />
          <ApprovalControls
            status={state.draft.status}
            submitting={state.submitting}
            error={state.submitError}
            onDecide={(d, c) => void decide(d, c)}
          />
        </div>
      )}
    </section>
  );
}
