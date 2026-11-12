"use client";

import { useRef, useState } from "react";
import type { ConsultationDraft } from "@/shared/contracts";
import { deliveryApi, DeliveryError } from "../hooks/deliveryState";

const EXAMPLES = ["Make it shorter and focus on the ECG findings.", "Leave out the medications.", "Lead with the presenting symptoms."];

/**
 * Natural-language revision. The assistant can reword and reselect documented facts; it cannot
 * add facts, and the revised draft always comes back for the physician's decision.
 */
export function ModelRevision({ draft, onRevised }: { draft: ConsultationDraft; onRevised: () => void }) {
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  // One key per instruction, so a retry after a dropped connection cannot apply it twice.
  const key = useRef<{ text: string; id: string } | undefined>(undefined);

  async function revise() {
    const text = instruction.trim();
    if (!draft.version || text.length < 3) return;
    if (key.current?.text !== text) key.current = { text, id: crypto.randomUUID() };
    setBusy(true);
    setError("");
    setDone(false);
    try {
      await deliveryApi.reviseWithModel(draft.id, { instruction: text, expectedVersion: draft.version, idempotencyKey: key.current.id });
      key.current = undefined;
      setInstruction("");
      setDone(true);
      onRevised();
    } catch (e) {
      setError(e instanceof DeliveryError ? e.message : "The draft could not be revised.");
      onRevised();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form aria-label="Ask the assistant to revise" className="space-y-2 rounded border border-sky-800 bg-sky-50 p-3"
      onSubmit={(event) => { event.preventDefault(); void revise(); }}>
      <label className="block text-sm font-semibold" htmlFor={`revise-${draft.id}`}>Ask the assistant to revise this draft</label>
      <textarea id={`revise-${draft.id}`} rows={2} maxLength={1000} value={instruction} disabled={busy}
        onChange={(event) => setInstruction(event.target.value)} placeholder="For example: make it shorter and focus on the ECG findings"
        className="block w-full rounded border border-slate-400 bg-white px-2 py-1 text-sm" />
      <div className="flex flex-wrap gap-1">
        {EXAMPLES.map((example) => (
          <button key={example} type="button" disabled={busy} onClick={() => setInstruction(example)}
            className="rounded-full border border-sky-800 bg-white px-2 py-0.5 text-xs text-sky-900 disabled:opacity-50">{example}</button>
        ))}
      </div>
      <button type="submit" disabled={busy || instruction.trim().length < 3}
        className="rounded border border-sky-900 bg-sky-800 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
        {busy ? "Revising…" : "Revise draft"}
      </button>
      <p className="text-xs text-slate-700">The assistant can change wording and which documented facts are included. It cannot add facts, and you review the result before anything is sent.</p>
      {busy && <p role="status" className="text-sm text-slate-700">The assistant is rewriting the draft and re-checking every statement against the chart…</p>}
      {done && <p role="status" className="text-sm text-emerald-800">Draft revised. Review the new version below.</p>}
      {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
    </form>
  );
}
