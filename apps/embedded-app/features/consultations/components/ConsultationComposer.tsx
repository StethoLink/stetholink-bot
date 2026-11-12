"use client";

import { useEffect, useState } from "react";
import type { ConsultationListItem } from "@/shared/contracts";
import { getApiClient } from "@/shared/api-client";
import { deliveryApi } from "../hooks/deliveryState";
import { ConsultationReview } from "./ConsultationReview";
import { DraftStatusBadge } from "./DraftStatusBadge";

const SPECIALTIES = ["Cardiology", "Radiology"];
const field = "mt-1 block w-full rounded border border-slate-400 px-2 py-1 text-sm font-normal";

/** Request a consultation for the open chart, or return to one prepared earlier. */
export function ConsultationComposer({ patientId, encounterId, canReview = false, canRoute = false }: {
  patientId: string; encounterId?: string; canReview?: boolean; canRoute?: boolean;
}) {
  const [draftId, setDraftId] = useState<string>();
  const [specialty, setSpecialty] = useState(SPECIALTIES[0]);
  const [question, setQuestion] = useState("");
  const [existing, setExisting] = useState<ConsultationListItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (draftId) return;
    void deliveryApi.list().then(setExisting).catch(() => setExisting([]));
  }, [draftId]);

  async function prepare() {
    setBusy(true);
    setError("");
    try {
      const draft = await getApiClient().createConsultationDraft({ patientId, encounterId, specialty, clinicalQuestion: question.trim() });
      setDraftId(draft.id);
    } catch {
      setError("The consultation could not be prepared. Check your session and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (draftId) {
    return (
      <section aria-label="Consultation" className="space-y-3">
        <button type="button" onClick={() => setDraftId(undefined)} className="text-sm underline">← All consultations for this chart</button>
        <ConsultationReview draftId={draftId} canReview={canReview} canRoute={canRoute} />
      </section>
    );
  }

  return (
    <section aria-label="Prepare consultation" className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="text-base font-semibold">Request a consultation</h2>
      <label className="block text-sm font-medium">Specialty
        <select value={specialty} onChange={(event) => setSpecialty(event.target.value)} className={field}>
          {SPECIALTIES.map((name) => <option key={name}>{name}</option>)}
        </select>
      </label>
      <label className="block text-sm font-medium">Clinical question for the specialist
        <textarea rows={3} value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={4000} className={field}
          placeholder="What do you want the specialist to answer?" />
      </label>
      <button type="button" disabled={busy || !question.trim()} onClick={() => void prepare()}
        className="rounded border border-slate-700 px-3 py-2 text-sm font-medium disabled:opacity-50">
        {busy ? "Preparing…" : "Prepare consultation for review"}
      </button>
      {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
      {existing.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold">Consultations for this chart</h3>
          <ul className="space-y-1">
            {existing.map((item) => (
              <li key={item.id}>
                <button type="button" onClick={() => setDraftId(item.id)} className="flex w-full flex-wrap items-center gap-2 rounded border border-slate-300 px-2 py-1 text-left text-sm">
                  <span className="font-medium">{item.specialty ?? "Specialty not set"}</span>
                  <DraftStatusBadge status={item.status} />
                  <span className="text-xs text-slate-700">{new Date(item.updatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
