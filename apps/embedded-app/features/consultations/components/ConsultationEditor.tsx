"use client";

import { useState } from "react";
import type { ConsultationDraft } from "@/shared/contracts";

export function ConsultationEditor({ draft, version, onSaved }: {
  draft: ConsultationDraft;
  version: number;
  onSaved: () => void;
}) {
  const [summary, setSummary] = useState(draft.summary);
  const [assessment, setAssessment] = useState(draft.assessment);
  const [plan, setPlan] = useState(draft.plan.join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const planChanged = plan !== draft.plan.join("\n");
  const dirty = summary !== draft.summary || assessment !== draft.assessment || planChanged;
  const url = `/api/consultations/drafts/${encodeURIComponent(draft.id)}`;

  async function save(action: "revise" | "submit") {
    setBusy(true);
    setError("");
    const base = { expectedVersion: version, idempotencyKey: `${action}:${version}:${draft.id}` };
    try {
      const response = await fetch(action === "revise" ? url : url + "/transitions", {
        method: action === "revise" ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "revise"
          ? { ...base, summary, assessment, plan: planChanged ? plan.split("\n").filter(Boolean) : draft.plan }
          : { ...base, action }),
      });
      if (!response.ok) throw new Error("Draft update failed");
      onSaved();
    } catch {
      setError("The draft could not be updated. Reload the draft before trying again.");
    } finally {
      setBusy(false);
    }
  }

  return <form className="space-y-3" onSubmit={(event) => {
    event.preventDefault();
    if (dirty && !busy) void save("revise");
  }}>
    <label className="block">Summary
      <textarea className="block w-full rounded border p-2" required maxLength={16000}
        value={summary} onChange={(event) => setSummary(event.target.value)} />
    </label>
    <label className="block">Assessment
      <textarea className="block w-full rounded border p-2" maxLength={16000}
        value={assessment} onChange={(event) => setAssessment(event.target.value)} />
    </label>
    <label className="block">Plan (one item per line)
      <textarea className="block w-full rounded border p-2"
        value={plan} onChange={(event) => setPlan(event.target.value)} />
    </label>
    <div className="flex gap-2">
      <button type="submit" disabled={busy || !dirty} className="rounded border px-3 py-2">Save edits</button>
      <button type="button" disabled={busy || dirty} onClick={() => void save("submit")}
        className="rounded border px-3 py-2">Submit for review</button>
    </div>
    {error && <p role="alert">{error}</p>}
  </form>;
}
