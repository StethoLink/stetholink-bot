"use client";

import { useRef, useState } from "react";
import type { ConsultationDraft } from "@/shared/contracts";
import { Alert, WorkInProgress } from "@/apps/embedded-app/components/ui";
import { useT } from "@/apps/embedded-app/i18n/client";
import { CancelledError, deliveryApi, DeliveryError } from "../hooks/deliveryState";

/**
 * Natural-language revision. The assistant can reword and reselect documented facts; it cannot
 * add facts, and the revised draft always comes back for the physician's decision.
 */
export function ModelRevision({ draft, onRevised }: { draft: ConsultationDraft; onRevised: () => void }) {
  const { t } = useT();
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  // One key per instruction, so a retry after a dropped connection cannot apply it twice.
  const key = useRef<{ text: string; id: string } | undefined>(undefined);
  const abort = useRef<AbortController | undefined>(undefined);

  async function revise() {
    const text = instruction.trim();
    if (!draft.version || text.length < 3) return;
    if (key.current?.text !== text) key.current = { text, id: crypto.randomUUID() };
    abort.current = new AbortController();
    setBusy(true);
    setError("");
    setDone(false);
    try {
      await deliveryApi.reviseWithModel(draft.id, { instruction: text, expectedVersion: draft.version, idempotencyKey: key.current.id }, abort.current.signal);
      key.current = undefined;
      setInstruction("");
      setDone(true);
      onRevised();
    } catch (e) {
      setError(e instanceof CancelledError ? "" : e instanceof DeliveryError ? e.message : t.work.revision.error);
      onRevised();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form aria-label={t.work.revision.aria} className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3"
      onSubmit={(event) => { event.preventDefault(); void revise(); }}>
      <label className="block text-sm font-semibold" htmlFor={`revise-${draft.id}`}>{t.work.revision.label}</label>
      <textarea id={`revise-${draft.id}`} rows={2} maxLength={1000} value={instruction} disabled={busy}
        onChange={(event) => setInstruction(event.target.value)} placeholder={t.work.revision.placeholder}
        onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void revise(); } }}
        className="field" dir="auto" />
      <div className="flex flex-wrap gap-1">
        {t.work.revision.examples.map((example) => (
          <button key={example} type="button" disabled={busy} onClick={() => setInstruction(example)}
            className="rounded-full border border-sky-200 bg-white px-2.5 py-1 text-xs text-sky-900 hover:bg-sky-50 disabled:opacity-50">{example}</button>
        ))}
      </div>
      <button type="submit" disabled={busy || instruction.trim().length < 3} className="btn btn-primary">{t.work.revision.button}</button>
      <p className="text-xs text-slate-700">{t.work.revision.note}</p>
      {busy && <WorkInProgress label={t.work.revision.busy} onCancel={() => abort.current?.abort()} />}
      {done && <p role="status" className="text-sm text-emerald-800">{t.work.revision.done}</p>}
      {error && <Alert tone="danger">{error}</Alert>}
    </form>
  );
}
