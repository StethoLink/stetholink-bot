"use client";

import type { StethoLinkApiClient } from "@/shared/api-client";
import { useConsultationDraft } from "../hooks/useConsultationDraft";
import { ConsultationDraftView } from "./ConsultationDraftView";

/** Loads a consultation draft and lets the clinician approve, reject or request changes. */
export function ConsultationReview({ draftId, client }: { draftId: string; client?: StethoLinkApiClient }) {
  const { state, submitting, submitError, decide, reload } = useConsultationDraft(draftId, client);

  if (state.status === "loading") {
    return (
      <section aria-busy="true" aria-label="Consultation draft" className="rounded-lg border border-slate-200 bg-white p-4">
        <p className="sr-only">Loading consultation draft…</p>
        <div className="space-y-2 motion-safe:animate-pulse" aria-hidden="true">
          <div className="h-5 w-1/2 rounded bg-slate-200" />
          <div className="h-4 w-full rounded bg-slate-200" />
          <div className="h-4 w-5/6 rounded bg-slate-200" />
        </div>
      </section>
    );
  }

  if (state.status === "error") {
    return (
      <section aria-label="Consultation draft" className="rounded-lg border border-red-800 bg-red-50 p-4 text-red-900">
        <p role="alert">{state.message}</p>
        <button
          type="button"
          onClick={reload}
          className="mt-2 rounded border border-red-800 bg-white px-3 py-1.5 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-900"
        >
          Retry
        </button>
      </section>
    );
  }

  return (
    <ConsultationDraftView
      draft={state.draft}
      submitting={submitting}
      submitError={submitError}
      onDecide={decide}
      onReload={reload}
    />
  );
}
