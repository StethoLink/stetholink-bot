"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChartWriteResult, ConsultationDeliveryView } from "@/shared/contracts";
import { Alert, Badge, Button, ConfirmDialog } from "@/apps/embedded-app/components/ui";
import { useT } from "@/apps/embedded-app/i18n/client";
import { formatDateTime } from "@/apps/embedded-app/i18n/format";
import { awaitingProvider, deliveryApi, DeliveryError, describeDelivery } from "../hooks/deliveryState";

/** Delivery to the approved destination, its state and the specialist's reply. */
export function ConsultationDelivery({ draftId, canRoute, onChanged, onView }: {
  draftId: string; canRoute: boolean; onChanged?: () => void; onView?: (view: ConsultationDeliveryView | null) => void;
}) {
  const { t, locale } = useT();
  const d = t.work.delivery;
  const when = (iso: string) => formatDateTime(iso, locale);
  const [view, setView] = useState<ConsultationDeliveryView | null>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [chart, setChart] = useState<ChartWriteResult[]>([]);
  const [charting, setCharting] = useState(false);
  const [chartBusy, setChartBusy] = useState(false);
  const status = view?.status;
  useEffect(() => { void deliveryApi.chart(draftId).then(setChart).catch(() => undefined); }, [draftId, status]);
  async function writeChart() {
    setChartBusy(true);
    setError("");
    try { setChart(await deliveryApi.writeToChart(draftId, chart.filter((entry) => entry.status !== "created" && entry.status !== "existing").map((entry) => entry.item as "consultation" | "report"))); }
    catch (e) { setError(e instanceof DeliveryError ? e.message : d.errors.chart); }
    finally { setChartBusy(false); setCharting(false); }
  }
  // One key per send intent: a retry after a network failure cannot create a second request.
  const sendKey = useRef<string | undefined>(undefined);
  const lastVersion = useRef<number | undefined>(undefined);

  const apply = useCallback((next: ConsultationDeliveryView | null) => {
    setView(next);
    onView?.(next);
    if (next && lastVersion.current !== undefined && lastVersion.current !== next.version) onChanged?.();
    lastVersion.current = next?.version;
  }, [onChanged, onView]);

  const refresh = useCallback(async () => {
    try {
      apply(await deliveryApi.view(draftId));
      setError("");
    } catch (e) {
      setError(e instanceof DeliveryError ? e.message : d.errors.status);
    }
  }, [apply, draftId, d.errors.status]);

  useEffect(() => { void refresh(); }, [refresh]);

  const waiting = awaitingProvider(view);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [waiting, refresh]);

  async function run(action: () => Promise<ConsultationDeliveryView>) {
    setBusy(true);
    setError("");
    try {
      apply(await action());
      sendKey.current = undefined;
    } catch (e) {
      setError(e instanceof DeliveryError ? e.message : d.errors.action);
      await refresh();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (view === undefined) return <p className="text-sm text-slate-700" aria-busy="true">{d.loading}</p>;
  if (view === null) return <p className="text-sm text-slate-700" role="status">{d.unavailable}</p>;

  const { state, problem } = describeDelivery(view, d);
  const target = view.provider?.id ?? "";
  const send = () => run(() => deliveryApi.send(draftId, {
    providerId: target, expectedVersion: view.version, idempotencyKey: sendKey.current ??= crypto.randomUUID(),
  }));

  return (
    <section aria-label={d.heading} className="card card-pad space-y-3">
      <h3 className="text-sm font-semibold">{d.heading}</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="font-medium">{d.deliveryState}</dt>
        <dd role="status">{state}</dd>
        <dt className="font-medium">{d.recipient}</dt>
        <dd>
          {view.provider ? <bdi>{view.provider.displayName}</bdi> : d.notApprovedYet}
        </dd>
      </dl>

      {problem && <p role="alert" className="alert alert-danger">{problem}</p>}

      {(view.canSend || view.canRetry) && !canRoute && (
        <p role="status" className="text-sm text-slate-700">{d.onlyPhysician}</p>
      )}
      {(view.canSend || view.canRetry) && canRoute && (
        <Button variant="primary" disabled={busy || !target} onClick={() => setConfirming(true)}>
          {view.canRetry ? d.retry : d.send}
        </Button>
      )}
      <ConfirmDialog open={confirming} onClose={() => setConfirming(false)} onConfirm={() => void send()} busy={busy}
        title={d.sendTitle(view.provider?.displayName ?? d.theApprovedProvider)} confirmLabel={d.sendNow}>
        <p className="font-medium">{d.receivesHeading}</p>
        <ul className="list-disc space-y-0.5 ps-5 text-slate-800">
          {d.receives.map((line) => <li key={line}>{line}</li>)}
        </ul>
        <p className="font-medium">{d.notSentHeading}</p>
        <ul className="list-disc space-y-0.5 ps-5 text-slate-800">
          {d.notSent.map((line) => <li key={line}>{line}</li>)}
        </ul>
        <p className="text-xs text-slate-700">{d.sendWarning}</p>
      </ConfirmDialog>

      {view.attempts.length > 0 && (
        <div>
          <h4 className="text-sm font-medium">{d.history}</h4>
          <ol className="text-sm">
            {[...view.attempts].reverse().map((attempt) => (
              <li key={attempt.requestId}>
                {d.attempt(attempt.number, d.attemptStatus[attempt.status], when(attempt.updatedAt), attempt.requestId.slice(0, 8))}
              </li>
            ))}
          </ol>
        </div>
      )}

      {view.responses.filter((response) => response.kind === "rejected").map((response) => (
        <p key={response.responseId} className="text-sm" dir="auto">{d.declined(response.reason ?? d.noReason)}</p>
      ))}

      {view.report?.report && (
        <article aria-label={d.responseHeading} className="alert alert-success space-y-2">
          <h4 className="font-semibold">{d.responseHeading}</h4>
          <p className="text-xs text-slate-700">
            {d.from(view.report.report.responder, view.provider?.displayName ?? view.report.providerId, when(view.report.receivedAt), view.report.requestId.slice(0, 8))}
          </p>
          <p className="whitespace-pre-wrap" dir="auto">{view.report.report.summary}</p>
          {view.report.report.recommendations.length > 0 && (
            <ul className="list-disc ps-5">
              {view.report.report.recommendations.map((item, index) => <li key={index} dir="auto">{item}</li>)}
            </ul>
          )}
        </article>
      )}

      <div className="flex flex-wrap gap-2">
        {view.attempts.length > 0 && (
          <Button disabled={busy} onClick={() => void refresh()}>{d.refresh}</Button>
        )}
      </div>
      {chart.length > 0 && (
        <div className="space-y-2 border-t border-slate-200 pt-3" role="group" aria-label={d.chartGroup}>
          <h4 className="text-sm font-medium">{d.chartHeading}</h4>
          <ul className="space-y-1.5">
            {chart.map((entry) => {
              const done = entry.status === "created" || entry.status === "existing";
              return (
                <li key={entry.itemKey} className="flex flex-wrap items-center gap-2 text-sm">
                  <span>{entry.item === "report" ? d.items.report : d.items.consultation}</span>
                  {done ? <Badge tone="success" dot>{d.inChart}</Badge> : entry.status === "pending" ? <Badge tone="neutral" dot>{d.notWrittenYet}</Badge>
                    : <Badge tone={entry.status === "failed" ? "danger" : "warning"} dot>{d.notWrittenCopy}</Badge>}
                  {!done && entry.status !== "pending" && entry.copyText && <Button size="sm" onClick={() => void navigator.clipboard.writeText(entry.copyText!)}>{d.copyToChart}</Button>}
                  {entry.failure && <span className="w-full text-xs text-slate-700" dir="auto">{entry.failure}.</span>}
                </li>
              );
            })}
          </ul>
          {canRoute && chart.some((entry) => entry.status !== "created" && entry.status !== "existing") && (
            <Button disabled={chartBusy} onClick={() => setCharting(true)}>{d.writeToChart}</Button>
          )}
          <ConfirmDialog open={charting} onClose={() => setCharting(false)} onConfirm={() => void writeChart()} busy={chartBusy} title={d.writeTitle} confirmLabel={d.writeConfirm}>
            <p className="font-medium">{d.writeIntro}</p>
            <ul className="list-disc space-y-0.5 ps-5 text-slate-800">
              {chart.filter((entry) => entry.status !== "created" && entry.status !== "existing").map((entry) => <li key={entry.itemKey}>{entry.item === "report" ? d.writeItems.report : d.writeItems.consultation}</li>)}
            </ul>
            <p className="text-xs text-slate-700">{d.writeNote}</p>
          </ConfirmDialog>
        </div>
      )}
      {error && <Alert tone="danger"><span dir="auto">{error}</span></Alert>}
    </section>
  );
}
