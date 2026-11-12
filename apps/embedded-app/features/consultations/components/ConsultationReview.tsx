"use client";

import { useCallback, useEffect, useState } from "react";
import type { StethoLinkApiClient } from "@/shared/api-client";
import type { ConsultationDeliveryView } from "@/shared/contracts";
import { useConsultationDraft } from "../hooks/useConsultationDraft";
import { deliveryApi, type EligibleProvider } from "../hooks/deliveryState";
import { ConsultationDelivery } from "./ConsultationDelivery";
import { ApprovalControls } from "./ApprovalControls";
import { ConsultationDraftView } from "./ConsultationDraftView";
import { ConsultationEditor } from "./ConsultationEditor";
import { ModelRevision } from "./ModelRevision";
import { StatusTracker } from "./StatusTracker";

const ROUTABLE = ["approved", "queued", "sent", "accepted", "responded", "failed", "cancelled"];

/** Loads a consultation and lets the clinician review, revise, decide on and send it. */
export function ConsultationReview({ draftId, client, canReview = false, canRoute = false }: {
  draftId: string;
  client?: StethoLinkApiClient;
  canReview?: boolean;
  canRoute?: boolean;
}) {
  const { state, reload, refresh, decide } = useConsultationDraft(draftId, { client });
  const [destinations, setDestinations] = useState<EligibleProvider[]>();
  const [delivery, setDelivery] = useState<ConsultationDeliveryView | null>();
  const pending = state.status === "ready" && ["pending_approval", "pending_review"].includes(state.draft.status);
  const onDelivery = useCallback((view: ConsultationDeliveryView | null) => setDelivery(view), []);

  useEffect(() => {
    if (!canReview || !pending) return;
    let active = true;
    void deliveryApi.providers(draftId).then((list) => active && setDestinations(list)).catch(() => active && setDestinations([]));
    return () => { active = false; };
  }, [canReview, pending, draftId]);

  return (
    <section aria-label="Consultation review" className="rounded-lg border border-slate-200 bg-white p-4">
      {(state.status === "idle" || state.status === "loading") && (
        <div role="status" aria-busy="true" aria-label="Loading consultation draft" className="space-y-3">
          <div className="h-5 w-1/3 animate-pulse rounded bg-slate-200" />
          <div className="h-16 animate-pulse rounded bg-slate-200" />
          <div className="h-16 animate-pulse rounded bg-slate-200" />
        </div>
      )}
      {state.status === "error" && (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-red-800">{state.error}</p>
          <button type="button" onClick={reload} className="rounded border border-slate-700 px-2 py-1 text-sm">
            Retry
          </button>
        </div>
      )}
      {state.status === "ready" && (
        <div className="space-y-4">
          <StatusTracker status={state.draft.lifecycleStatus ?? state.draft.status} latestAttempt={delivery?.attempts[0]?.status} />
          <ConsultationDraftView draft={state.draft} />
          {pending && canReview && state.draft.grounding?.authoring && state.draft.version !== undefined && (
            <ModelRevision key={state.draft.version} draft={state.draft} onRevised={refresh} />
          )}
          {state.draft.status === "draft" && state.draft.version !== undefined && (
            <ConsultationEditor key={state.draft.version} draft={state.draft} onSaved={refresh} />
          )}
          {ROUTABLE.includes(state.draft.status) && (
            <ConsultationDelivery draftId={state.draft.id} canRoute={canRoute} onChanged={refresh} onView={onDelivery} />
          )}
          {canReview ? (
            <ApprovalControls
              status={state.draft.status}
              submitting={state.submitting}
              error={state.submitError}
              destinations={destinations ?? []}
              destinationsLoading={pending && destinations === undefined}
              onDecide={(decision, recipientId) => void decide(decision, recipientId)}
            />
          ) : pending && (
            <p role="status" className="text-sm text-slate-700">A physician must review this draft before it can be sent.</p>
          )}
        </div>
      )}
    </section>
  );
}
