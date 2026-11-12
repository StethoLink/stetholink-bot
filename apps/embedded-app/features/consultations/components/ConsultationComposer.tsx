"use client";

import { useEffect, useRef, useState } from "react";
import type { ConsultationListItem } from "@/shared/contracts";
import { deliveryApi, DeliveryError } from "../hooks/deliveryState";
import { ConsultationReview } from "./ConsultationReview";
import { DraftStatusBadge } from "./DraftStatusBadge";

export interface AssistantInfo {
  provider: string;
  model: string;
  /** False when the deterministic demo fallback is in use. */
  liveInference: boolean;
  /** False when a live model is selected but its key or cost limits are missing. */
  configured: boolean;
}

const EXAMPLES = [
  "Prepare a cardiology consultation for this patient regarding possible acute coronary syndrome.",
  "Prepare a radiology consultation asking whether further chest imaging is needed.",
];

/** Ask the assistant for a consultation in plain language, or return to one prepared earlier. */
export function ConsultationComposer({ patientId, encounterId, canReview = false, canRoute = false, assistant }: {
  patientId: string; encounterId?: string; canReview?: boolean; canRoute?: boolean; assistant?: AssistantInfo;
}) {
  const [draftId, setDraftId] = useState<string>();
  const [request, setRequest] = useState("");
  const [existing, setExisting] = useState<ConsultationListItem[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // One key per request text: retrying after a timeout returns the same draft instead of a second one.
  const key = useRef<{ text: string; id: string } | undefined>(undefined);

  useEffect(() => {
    if (draftId) return;
    let active = true;
    void deliveryApi.list().then((list) => active && setExisting(list)).catch(() => active && setExisting([]));
    return () => { active = false; };
  }, [draftId]);

  async function prepare() {
    const text = request.trim();
    if (text.length < 8) return;
    if (key.current?.text !== text) key.current = { text, id: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      const draft = await deliveryApi.create({ patientId, encounterId, request: text, idempotencyKey: key.current.id });
      key.current = undefined;
      setRequest("");
      setDraftId(draft.id);
    } catch (e) {
      setError(e instanceof DeliveryError ? e.message : "The consultation could not be prepared.");
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
    <section aria-label="Consultation assistant" className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
      <div>
        <h2 className="text-base font-semibold">Consultation assistant</h2>
        {assistant && (assistant.liveInference ? (
          <p className="text-xs text-slate-700">
            Drafts are written by {assistant.provider} model <span className="font-medium">{assistant.model}</span> from this chart, then checked against it.
            {!assistant.configured && <span className="font-semibold text-red-800"> The model is not fully configured, so drafting will fail until its key and cost limits are set.</span>}
          </p>
        ) : (
          <p role="note" className="rounded border border-amber-700 bg-amber-50 p-2 text-xs text-amber-900">
            <span className="font-semibold">Demo fallback.</span> No language model is configured. Drafts copy the chart record into sections without AI inference.
          </p>
        ))}
      </div>
      <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void prepare(); }}>
        <label className="block text-sm font-medium" htmlFor="consultation-request">What consultation do you need?</label>
        <textarea id="consultation-request" rows={3} value={request} onChange={(event) => setRequest(event.target.value)} maxLength={2000} disabled={busy}
          className="block w-full rounded border border-slate-400 px-2 py-1 text-sm"
          placeholder="Name the specialty and what you want answered, in your own words" />
        <div className="flex flex-wrap gap-1">
          {EXAMPLES.map((example) => (
            <button key={example} type="button" disabled={busy} onClick={() => setRequest(example)}
              className="rounded-full border border-slate-400 px-2 py-0.5 text-left text-xs text-slate-800 disabled:opacity-50">{example}</button>
          ))}
        </div>
        <button type="submit" disabled={busy || request.trim().length < 8}
          className="rounded border border-sky-900 bg-sky-800 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
          {busy ? "Preparing…" : "Prepare consultation"}
        </button>
        <p className="text-xs text-slate-700">The assistant prepares a draft for your review. It cannot approve, send, order or change the chart.</p>
        {busy && <p role="status" className="text-sm text-slate-700">Reading the chart and drafting the consultation. This can take up to a minute…</p>}
        {error && <p role="alert" className="rounded border border-red-700 bg-red-50 p-2 text-sm text-red-800">{error}</p>}
      </form>

      <div>
        <h3 className="text-sm font-semibold">Consultations for this chart</h3>
        {existing === undefined ? (
          <p className="text-sm text-slate-700" aria-busy="true">Loading…</p>
        ) : existing.length === 0 ? (
          <p className="text-sm text-slate-700">None yet.</p>
        ) : (
          <ul className="space-y-1">
            {existing.map((item) => (
              <li key={item.id}>
                <button type="button" onClick={() => setDraftId(item.id)} className="flex w-full flex-wrap items-center gap-2 rounded border border-slate-300 px-2 py-1 text-left text-sm hover:bg-slate-50">
                  <span className="font-medium">{item.specialty ?? "Specialty not set"}</span>
                  <DraftStatusBadge status={item.status} />
                  <span className="text-xs text-slate-700">{new Date(item.updatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
