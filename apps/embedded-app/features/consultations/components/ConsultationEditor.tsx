"use client";

import { useRef, useState } from "react";
import type { ConsultationDraft } from "@/shared/contracts";
import { useT } from "@/apps/embedded-app/i18n/client";
import { deliveryApi, DeliveryError } from "../hooks/deliveryState";

const field = "field mt-1 font-normal";

/** Physician edits to a draft that was returned for changes. Saving sends it back for review; it never approves. */
export function ConsultationEditor({ draft, onSaved }: { draft: ConsultationDraft; onSaved: () => void }) {
  const { t } = useT();
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
      setError(e instanceof DeliveryError ? e.message : t.work.editor.error);
      setBusy(false);
    }
  }

  return (
    <form aria-label={t.work.editor.aria} className="card card-pad space-y-2"
      onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <h3 className="text-sm font-semibold">{t.work.editor.heading}</h3>
      <p className="text-xs text-slate-700">{t.work.editor.help}</p>
      <label className="block text-sm font-medium">{t.work.editor.summary}
        <textarea rows={8} required value={summary} onChange={(event) => setSummary(event.target.value)} className={field} dir="auto" />
      </label>
      <label className="block text-sm font-medium">{t.work.editor.assessment}
        <textarea rows={4} value={assessment} onChange={(event) => setAssessment(event.target.value)} className={field} dir="auto" />
      </label>
      <label className="block text-sm font-medium">{t.work.editor.plan}
        <textarea rows={6} value={plan} onChange={(event) => setPlan(event.target.value)} className={field} dir="auto" />
      </label>
      <button type="submit" disabled={busy || !summary.trim() || !draft.version} className="btn btn-primary">
        {busy ? t.work.editor.saving : t.work.editor.save}
      </button>
      {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
    </form>
  );
}
