"use client";

import { useEffect, useRef, useState } from "react";
import type { ConsultationClarification, ConsultationClarificationNeeded } from "@/shared/contracts";
import { AiBadge, Alert, Button, Card, CardHeader, WorkInProgress } from "@/apps/embedded-app/components/ui";
import { useT } from "@/apps/embedded-app/i18n/client";
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
  const { t } = useT();
  const c = t.work.clarification;
  const [answers, setAnswers] = useState<string[]>(() => clarification.concerns.map(() => ""));
  const given = clarification.concerns.map((entry, index) => ({ question: entry.question, answer: answers[index]?.trim() ?? "" })).filter((entry) => entry.answer);
  const canProceed = !clarification.concerns.some((entry) => entry.kind === "missing_specialty");
  return (
    <section aria-label={c.aria} className="alert alert-warning space-y-3">
      <div>
        <h3 className="text-base font-semibold text-amber-950">{c.title}</h3>
        <p className="text-sm text-amber-950 break-words"><span className="font-medium">{c.yourRequest}</span> <bdi>{request}</bdi></p>
        <p className="text-xs text-amber-900">{c.nothingDrafted}</p>
      </div>
      {clarification.clarifications.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold tracking-wide text-amber-950 uppercase">{c.alreadyAnswered}</h4>
          <ul className="space-y-1 text-sm text-amber-950">
            {clarification.clarifications.map((entry, index) => (
              <li key={index} className="break-words" dir="auto"><span className="font-medium">{entry.question}</span> {entry.answer}</li>
            ))}
          </ul>
        </div>
      )}
      <ol className="space-y-3">
        {clarification.concerns.map((entry, index) => (
          <li key={index} className="rounded-md border border-amber-100 bg-white p-2.5">
            <p className="text-xs font-semibold tracking-wide text-amber-900 uppercase">{t.work.concerns[entry.kind]}</p>
            <p className="text-sm font-medium break-words" dir="auto">{entry.concern}</p>
            <label className="mt-1 block text-sm break-words" htmlFor={`clarification-${index}`} dir="auto">{entry.question}</label>
            {clarification.canAnswer && (
              <textarea id={`clarification-${index}`} rows={2} maxLength={1000} disabled={busy} value={answers[index] ?? ""}
                onChange={(event) => setAnswers((current) => current.map((value, i) => (i === index ? event.target.value : value)))}
                className="field mt-1" placeholder={c.answerPlaceholder} dir="auto" />
            )}
          </li>
        ))}
      </ol>
      {!clarification.canAnswer && <p className="text-sm text-amber-950">{c.maxAnswered}</p>}
      <div className="flex flex-wrap gap-2">
        {clarification.canAnswer && (
          <button type="button" disabled={busy || !given.length} onClick={() => onAnswer(given)}
            className="btn btn-primary">
            {c.answerContinue}
          </button>
        )}
        {canProceed && (
          <button type="button" disabled={busy} onClick={onProceed}
            className="btn btn-warning">{c.prepareAnyway}</button>
        )}
        <button type="button" disabled={busy} onClick={onEdit} className="btn btn-secondary">{c.changeRequest}</button>
      </div>
      {canProceed && <p className="text-xs text-amber-900">{c.keepVisible}</p>}
    </section>
  );
}

/** Ask the assistant for a consultation in plain language, then review what it prepared. */
export function ConsultationComposer({ patientId, encounterId, canReview = false, canRoute = false, assistant, openDraftId, onOpenDraft }: {
  patientId: string; encounterId?: string; canReview?: boolean; canRoute?: boolean; assistant?: AssistantInfo;
  /** The consultation being reviewed, when the parent controls it (for example from the History tab). */
  openDraftId?: string; onOpenDraft?(draftId: string | undefined): void;
}) {
  const { t } = useT();
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
      setError(e instanceof CancelledError ? "" : e instanceof DeliveryError ? e.message : t.work.composer.error);
    } finally {
      setBusy(false);
    }
  }
  if (draftId) {
    return (
      <section aria-label={t.work.composer.sectionLabel} className="space-y-3">
        <Button variant="ghost" size="sm" onClick={() => setDraftId(undefined)}>{t.work.composer.newRequest}</Button>
        <ConsultationReview draftId={draftId} canReview={canReview} canRoute={canRoute} />
      </section>
    );
  }
  return (
    <Card aria-label={t.work.composer.title} className="space-y-3">
      <CardHeader title={t.work.composer.title} actions={assistant ? <AiBadge>{t.work.composer.aiAssisted}</AiBadge> : undefined}
        description={assistant
          ? <>{t.work.composer.descPre(assistant.provider)} <span className="font-medium" dir="ltr">{assistant.model}</span> {t.work.composer.descPost}</>
          : undefined} />
      {busy ? (
        <WorkInProgress label={pending ? t.work.composer.busyAnswers : t.work.composer.busyDrafting} steps={t.work.composer.steps} onCancel={() => abort.current?.abort()} />
      ) : pending ? (
        <ClarificationPanel key={JSON.stringify(pending.clarification)} request={pending.request} clarification={pending.clarification} busy={busy}
          onAnswer={(answers) => void prepare({ text: pending.request, clarifications: [...pending.clarification.clarifications, ...answers] })}
          onProceed={() => void prepare({ text: pending.request, clarifications: pending.clarification.clarifications, proceed: true })}
          onEdit={() => { setRequest(pending.request); setPending(undefined); setError(""); }} />
      ) : (
        <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void prepare(); }}>
          <label className="field-label" htmlFor="consultation-request">{t.work.composer.requestLabel}</label>
          <textarea id="consultation-request" rows={3} value={request} onChange={(event) => setRequest(event.target.value)} maxLength={2000} className="field" dir="auto"
            onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void prepare(); } }}
            placeholder={t.work.composer.placeholder} />
          <div className="flex flex-wrap gap-1.5">
            {t.work.composer.examples.map((example) => (
              <button key={example} type="button" onClick={() => setRequest(example)}
                className="rounded-full border border-slate-300 bg-white px-2.5 py-1 text-start text-xs text-slate-800 hover:bg-slate-100">{example}</button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" disabled={request.trim().length < 8} className="btn btn-primary">{t.work.composer.prepare}</button>
            <span className="text-xs text-slate-600" dir="ltr">{t.work.composer.ctrlEnter}</span>
          </div>
          <p className="text-xs text-slate-700">{t.work.composer.help}</p>
        </form>
      )}
      {error && !busy && <Alert tone="danger">{error}</Alert>}
    </Card>
  );
}
