"use client";

import { useRef, useState } from "react";
import type { ConsultationDraft } from "@/shared/contracts";
import { deliveryApi, DeliveryError } from "../hooks/deliveryState";

const field = "mt-1 block w-full rounded border border-slate-400 px-2 py-1 text-sm font-normal";

/** Physician edits to a draft that was returned for changes. Saving sends it back for review; it never approves. */
export function ConsultationEditor({ draft, onSaved }: { draft: ConsultationDraft; onSaved: () => void }) {
  const [summary, setSummary] = useState(draft.summary);
  const [assessment, setAssessment] = useState(draft.assessment);
  const [plan, setPlan] = useState(draft.plan.join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const keys = useRef({ revise: crypto.randomUUID(), submit: crypto.randomUUID() });

  async function save() {
    if (!draft.version) return;
    setBusy(true);
    setError("");
    try {
      const revised = await deliveryApi.revise(draft.id, {
        expectedVersion: draft.version, idempotencyKey: keys.current.revise, summary, assessment,
        plan: plan.split("\n").map((line) => line.trim()).filter(Boolean),
      });
      await deliveryApi.submit(draft.id, { expectedVersion: revised.version ?? draft.version + 1, idempotencyKey: keys.current.submit });
      onSaved();
    } catch (e) {
      setError(e instanceof DeliveryError ? e.message : "Your edits could not be saved.");
      setBusy(false);
    }
  }

  return (
    <form aria-label="Edit consultation" className="space-y-2 rounded border border-slate-400 p-3"
      onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <h3 className="text-sm font-semibold">Edit consultation</h3>
      <p className="text-xs text-slate-700">Your edits replace the wording only. The source facts and missing information stay attached.</p>
      <label className="block text-sm font-medium">Summary
        <textarea rows={8} required value={summary} onChange={(event) => setSummary(event.target.value)} className={field} />
      </label>
      <label className="block text-sm font-medium">Assessment
        <textarea rows={4} value={assessment} onChange={(event) => setAssessment(event.target.value)} className={field} />
      </label>
      <label className="block text-sm font-medium">Plan (one item per line)
        <textarea rows={6} value={plan} onChange={(event) => setPlan(event.target.value)} className={field} />
      </label>
      <button type="submit" disabled={busy || !summary.trim() || !draft.version} className="rounded border border-slate-700 px-3 py-2 text-sm font-medium disabled:opacity-50">
        {busy ? "Saving…" : "Save edits and return to review"}
      </button>
      {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
    </form>
  );
}
