"use client";

import { useEffect, useRef, useState } from "react";
import type { ConsultationClarification, ConsultationClarificationNeeded } from "@/shared/contracts";
import { AiBadge, Alert, Button, Card, CardHeader, WorkInProgress } from "@/apps/embedded-app/components/ui";
import { CONCERN_LABELS } from "../concern-labels";
import { CancelledError, deliveryApi, DeliveryError } from "../hooks/deliveryState";
import { ConsultationReview } from "./ConsultationReview";

export interface AssistantInfo {
  provider: string;
  model: string;
}

/** The assistant's challenge to a request, shown before anything is drafted. */
function ClarificationPanel({ request, clarification, busy, onAnswer, onProceed, onEdit }: {
  request: string; clarification: ConsultationClarificationNeeded; busy: boolean;
  onAnswer(answers: ConsultationClarification[]): void; onProceed(): void; onEdit(): void;
}) {
  const [answers, setAnswers] = useState<string[]>(() => clarification.concerns.map(() => ""));
  const given = clarification.concerns.map((entry, index) => ({ question: entry.question, answer: answers[index]?.trim() ?? "" })).filter((entry) => entry.answer);
  const canProceed = !clarification.concerns.some((entry) => entry.kind === "missing_specialty");
  return (
    <section aria-label="The assistant questions this request" className="alert alert-warning space-y-3">
      <div>
        <h3 className="text-base font-semibold text-amber-950">The assistant is questioning this request before drafting</h3>
        <p className="text-sm text-amber-950 break-words"><span className="font-medium">Your request:</span> {request}</p>
        <p className="text-xs text-amber-900">Nothing has been drafted or saved yet. Answer, change the request, or prepare it anyway.</p>
      </div>
      {clarification.clarifications.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold tracking-wide text-amber-950 uppercase">Already answered</h4>
          <ul className="space-y-1 text-sm text-amber-950">
            {clarification.clarifications.map((entry, index) => (
              <li key={index} className="break-words"><span className="font-medium">{entry.question}</span> {entry.answer}</li>
            ))}
          </ul>
        </div>
      )}
      <ol className="space-y-3">
        {clarification.concerns.map((entry, index) => (
          <li key={index} className="rounded-md border border-amber-100 bg-white p-2.5">
            <p className="text-xs font-semibold tracking-wide text-amber-900 uppercase">{CONCERN_LABELS[entry.kind]}</p>
            <p className="text-sm font-medium break-words">{entry.concern}</p>
            <label className="mt-1 block text-sm break-words" htmlFor={`clarification-${index}`}>{entry.question}</label>
            {clarification.canAnswer && (
              <textarea id={`clarification-${index}`} rows={2} maxLength={1000} disabled={busy} value={answers[index] ?? ""}
                onChange={(event) => setAnswers((current) => current.map((value, i) => (i === index ? event.target.value : value)))}
                className="field mt-1" placeholder="Your answer" />
            )}
          </li>
        ))}
      </ol>
      {!clarification.canAnswer && <p className="text-sm text-amber-950">The maximum number of questions has been answered. Prepare the consultation anyway, or change the request.</p>}
      <div className="flex flex-wrap gap-2">
        {clarification.canAnswer && (
          <button type="button" disabled={busy || !given.length} onClick={() => onAnswer(given)}
            className="btn btn-primary">
            Answer and continue
          </button>
        )}
        {canProceed && (
          <button type="button" disabled={busy} onClick={onProceed}
            className="btn btn-warning">Prepare anyway</button>
        )}
        <button type="button" disabled={busy} onClick={onEdit} className="btn btn-secondary">Change my request</button>
      </div>
      {canProceed && <p className="text-xs text-amber-900">If you prepare it anyway, these concerns stay visible with the draft for your review. They are not sent to the specialist.</p>}
    </section>
  );
}

const EXAMPLES = [
  "Prepare a cardiology consultation for this patient regarding possible acute coronary syndrome.",
  "Prepare a radiology consultation asking whether further chest imaging is needed.",
];
const STEPS = ["Reading the chart", "Checking that the request fits the chart", "Writing the consultation", "Checking every statement against its source"];

/** Ask the assistant for a consultation in plain language, then review what it prepared. */
export function ConsultationComposer({ patientId, encounterId, canReview = false, canRoute = false, assistant, openDraftId, onOpenDraft }: {
  patientId: string; encounterId?: string; canReview?: boolean; canRoute?: boolean; assistant?: AssistantInfo;
  /** The consultation being reviewed, when the parent controls it (for example from the History tab). */
  openDraftId?: string; onOpenDraft?(draftId: string | undefined): void;
}) {
  const [ownDraftId, setOwnDraftId] = useState<string>();
  const draftId = onOpenDraft ? openDraftId : ownDraftId;
  const setDraftId = onOpenDraft ?? setOwnDraftId;
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The assistant's open questions about the request being prepared, and the request they are about.
  const [pending, setPending] = useState<{ request: string; clarification: ConsultationClarificationNeeded }>();
  // One key per exact request (text, answers, proceed): retrying after a timeout returns the same draft instead of a second one.
  const key = useRef<{ text: string; id: string } | undefined>(undefined);
  const abort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => abort.current?.abort(), []);

  async function prepare(options: { text?: string; clarifications?: ConsultationClarification[]; proceed?: boolean } = {}) {
    const text = (options.text ?? request).trim();
    if (text.length < 8 || busy) return;
    const clarifications = options.clarifications ?? [];
    const body = { request: text, ...(clarifications.length ? { clarifications } : {}), ...(options.proceed ? { proceed: true } : {}) };
    const fingerprint = JSON.stringify(body);
    if (key.current?.text !== fingerprint) key.current = { text: fingerprint, id: crypto.randomUUID() };
    abort.current = new AbortController();
    setBusy(true);
    setError("");
    try {
      const result = await deliveryApi.create({ patientId, encounterId, ...body, idempotencyKey: key.current.id }, abort.current.signal);
      key.current = undefined;
      if ("outcome" in result) {
        setPending({ request: text, clarification: result });
        return;
      }
      setPending(undefined);
      setRequest("");
      setDraftId(result.id);
    } catch (e) {
      // After a cancel the same key is kept, so pressing the button again returns the draft if the server finished it.
      setError(e instanceof CancelledError ? "" : e instanceof DeliveryError ? e.message : "The consultation could not be prepared. Try again.");
    } finally {
      setBusy(false);
    }
  }
  if (draftId) {
    return (
      <section aria-label="Consultation" className="space-y-3">
        <Button variant="ghost" size="sm" onClick={() => setDraftId(undefined)}>New consultation request</Button>
        <ConsultationReview draftId={draftId} canReview={canReview} canRoute={canRoute} />
      </section>
    );
  }
  return (
    <Card aria-label="Consultation assistant" className="space-y-3">
      <CardHeader title="Consultation assistant" actions={assistant ? <AiBadge>AI-assisted</AiBadge> : undefined}
        description={assistant
          ? <>Drafts are written by {assistant.provider} model <span className="font-medium">{assistant.model}</span> from this chart, then every statement is checked against it.</>
          : undefined} />
      {busy ? (
        <WorkInProgress label={pending ? "Reading your answers and the chart" : "Reading the chart and drafting the consultation"} steps={STEPS} onCancel={() => abort.current?.abort()} />
      ) : pending ? (
        <ClarificationPanel key={JSON.stringify(pending.clarification)} request={pending.request} clarification={pending.clarification} busy={busy}
          onAnswer={(answers) => void prepare({ text: pending.request, clarifications: [...pending.clarification.clarifications, ...answers] })}
          onProceed={() => void prepare({ text: pending.request, clarifications: pending.clarification.clarifications, proceed: true })}
          onEdit={() => { setRequest(pending.request); setPending(undefined); setError(""); }} />
      ) : (
        <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void prepare(); }}>
          <label className="field-label" htmlFor="consultation-request">What consultation do you need?</label>
          <textarea id="consultation-request" rows={3} value={request} onChange={(event) => setRequest(event.target.value)} maxLength={2000} className="field"
            onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void prepare(); } }}
            placeholder="Name the specialty and what you want answered, in your own words" />
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((example) => (
              <button key={example} type="button" onClick={() => setRequest(example)}
                className="rounded-full border border-slate-300 bg-white px-2.5 py-1 text-start text-xs text-slate-800 hover:bg-slate-100">{example}</button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" disabled={request.trim().length < 8} className="btn btn-primary">Prepare consultation</button>
            <span className="text-xs text-slate-600">Ctrl + Enter</span>
          </div>
          <p className="text-xs text-slate-700">The assistant prepares a draft for your review, and asks you first when the request does not fit the chart or is unclear. It cannot approve, send, order or change the chart.</p>
        </form>
      )}
      {error && !busy && <Alert tone="danger">{error}</Alert>}
    </Card>
  );
}
