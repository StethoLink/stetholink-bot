"use client";

import { useState } from "react";
import { getApiClient } from "@/shared/api-client";
import { ConsultationReview } from "./ConsultationReview";

export function ConsultationComposer({ patientId, encounterId }: { patientId: string; encounterId?: string }) {
  const [draftId, setDraftId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function prepare() {
    setBusy(true);
    setError("");
    try {
      const draft = await getApiClient().createConsultationDraft({ patientId, encounterId });
      setDraftId(draft.id);
    } catch {
      setError("The consultation could not be prepared. Check your session and try again.");
    } finally {
      setBusy(false);
    }
  }
  return <section aria-label="Prepare consultation" className="space-y-3">
    <button type="button" disabled={busy || !!draftId} onClick={() => void prepare()}
      className="rounded border px-3 py-2">
      {busy ? "Preparing…" : "Prepare consultation for review"}
    </button>
    {error && <p role="alert">{error}</p>}
    {draftId && <ConsultationReview draftId={draftId} />}
  </section>;
}
