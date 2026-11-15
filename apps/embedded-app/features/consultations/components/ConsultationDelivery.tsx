"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChartWriteResult, ConsultationDeliveryView } from "@/shared/contracts";
import { Alert, Badge, Button, ConfirmDialog } from "@/apps/embedded-app/components/ui";
import { awaitingProvider, deliveryApi, DeliveryError, describeDelivery } from "../hooks/deliveryState";

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Delivery to the approved destination, its state and the specialist's reply. */
export function ConsultationDelivery({ draftId, canRoute, onChanged, onView }: {
  draftId: string; canRoute: boolean; onChanged?: () => void; onView?: (view: ConsultationDeliveryView | null) => void;
}) {
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
    catch (e) { setError(e instanceof DeliveryError ? e.message : "The chart could not be updated. Try again."); }
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
      setError(e instanceof DeliveryError ? e.message : "Delivery status is unavailable.");
    }
  }, [apply, draftId]);

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
      setError(e instanceof DeliveryError ? e.message : "The action failed. Try again.");
      await refresh();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (view === undefined) return <p className="text-sm text-slate-700" aria-busy="true">Loading delivery status…</p>;
  if (view === null) return <p className="text-sm text-slate-700" role="status">Delivery is not available in this environment (no durable storage configured).</p>;

  const { state, problem } = describeDelivery(view);
  const target = view.provider?.id ?? "";
  const send = () => run(() => deliveryApi.send(draftId, {
    providerId: target, expectedVersion: view.version, idempotencyKey: sendKey.current ??= crypto.randomUUID(),
  }));

  return (
    <section aria-label="Routing and specialist response" className="card card-pad space-y-3">
      <h3 className="text-sm font-semibold">Routing and specialist response</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="font-medium">Delivery state</dt>
        <dd role="status">{state}</dd>
        <dt className="font-medium">Recipient</dt>
        <dd>
          {view.provider ? view.provider.displayName : "Not approved yet"}
          {view.provider?.transport === "mock" && <> <Badge tone="warning">Simulated provider</Badge></>}
        </dd>
      </dl>

      {problem && <p role="alert" className="alert alert-danger">{problem}</p>}

      {(view.canSend || view.canRetry) && !canRoute && (
        <p role="status" className="text-sm text-slate-700">Only a physician with routing permission can send this consultation.</p>
      )}
      {(view.canSend || view.canRetry) && canRoute && (
        <Button variant="primary" disabled={busy || !target} onClick={() => setConfirming(true)}>
          {view.canRetry ? "Retry delivery to the same provider" : "Send approved consultation"}
        </Button>
      )}
      <ConfirmDialog open={confirming} onClose={() => setConfirming(false)} onConfirm={() => void send()} busy={busy}
        title={`Send to ${view.provider?.displayName ?? "the approved provider"}?`} confirmLabel="Send now">
        <p className="font-medium">What the specialist receives</p>
        <ul className="list-disc space-y-0.5 ps-5 text-slate-800">
          <li>The approved consultation text, exactly as you approved it.</li>
          <li>The patient&apos;s age and sex, and the chart facts the text cites.</li>
        </ul>
        <p className="font-medium">What is not sent</p>
        <ul className="list-disc space-y-0.5 ps-5 text-slate-800">
          <li>The patient&apos;s name, birth date and record numbers.</li>
          <li>Chart facts the consultation does not cite.</li>
        </ul>
        <p className="text-xs text-slate-700">Sending cannot be undone. Pressing the button twice never sends twice.</p>
        {view.provider?.transport === "mock" && <Alert tone="warning">Simulated provider. No real specialist or organisation receives this consultation.</Alert>}
      </ConfirmDialog>

      {view.attempts.length > 0 && (
        <div>
          <h4 className="text-sm font-medium">Request history</h4>
          <ol className="text-sm">
            {[...view.attempts].reverse().map((attempt) => (
              <li key={attempt.requestId}>
                Attempt {attempt.number}: {attempt.status} · {when(attempt.updatedAt)} · request {attempt.requestId.slice(0, 8)}
              </li>
            ))}
          </ol>
        </div>
      )}

      {view.responses.filter((response) => response.kind === "rejected").map((response) => (
        <p key={response.responseId} className="text-sm">Provider declined: {response.reason ?? "no reason given"}</p>
      ))}

      {view.report?.report && (
        <article aria-label="Specialist response" className="alert alert-success space-y-2">
          <h4 className="font-semibold">Specialist response</h4>
          {view.provider?.transport === "mock" && (
            <p className="alert alert-warning text-xs font-semibold">
              Simulated response. Generated by the built-in test provider, not written by a clinician.
            </p>
          )}
          <p className="text-xs text-slate-700">
            From {view.report.report.responder} via {view.provider?.displayName ?? view.report.providerId} · received {when(view.report.receivedAt)}
            {" "}· request {view.report.requestId.slice(0, 8)}
          </p>
          <p className="whitespace-pre-wrap">{view.report.report.summary}</p>
          {view.report.report.recommendations.length > 0 && (
            <ul className="list-disc ps-5">
              {view.report.report.recommendations.map((item, index) => <li key={index}>{item}</li>)}
            </ul>
          )}
        </article>
      )}

      <div className="flex flex-wrap gap-2">
        {view.canSimulate && canRoute && (
          <Button disabled={busy} onClick={() => void run(() => deliveryApi.simulate(draftId))}>Simulate the provider&apos;s next reply</Button>
        )}
        {view.attempts.length > 0 && (
          <Button disabled={busy} onClick={() => void refresh()}>Refresh status</Button>
        )}
      </div>
      {chart.length > 0 && (
        <div className="space-y-2 border-t border-slate-200 pt-3" role="group" aria-label="Patient chart">
          <h4 className="text-sm font-medium">In the patient&apos;s chart</h4>
          <ul className="space-y-1.5">
            {chart.map((entry) => {
              const done = entry.status === "created" || entry.status === "existing";
              return (
                <li key={entry.itemKey} className="flex flex-wrap items-center gap-2 text-sm">
                  <span>{entry.item === "report" ? "Specialist reply" : "Consultation request"}</span>
                  {done ? <Badge tone="success" dot>In the chart</Badge> : entry.status === "pending" ? <Badge tone="neutral" dot>Not written yet</Badge>
                    : <Badge tone={entry.status === "failed" ? "danger" : "warning"} dot>Not written: copy it</Badge>}
                  {!done && entry.status !== "pending" && entry.copyText && <Button size="sm" onClick={() => void navigator.clipboard.writeText(entry.copyText!)}>Copy to chart</Button>}
                  {entry.failure && <span className="w-full text-xs text-slate-700">{entry.failure}.</span>}
                </li>
              );
            })}
          </ul>
          {canRoute && chart.some((entry) => entry.status !== "created" && entry.status !== "existing") && (
            <Button disabled={chartBusy} onClick={() => setCharting(true)}>Write to chart</Button>
          )}
          <ConfirmDialog open={charting} onClose={() => setCharting(false)} onConfirm={() => void writeChart()} busy={chartBusy} title="Write to the patient's chart?" confirmLabel="Write to chart">
            <p className="font-medium">This is added to the chart in the EHR, as clinical notes for this visit under your name:</p>
            <ul className="list-disc space-y-0.5 ps-5 text-slate-800">
              {chart.filter((entry) => entry.status !== "created" && entry.status !== "existing").map((entry) => <li key={entry.itemKey}>{entry.item === "report" ? "The specialist's reply, as received" : "The consultation request you approved"}</li>)}
            </ul>
            <p className="text-xs text-slate-700">Nothing already in the chart is changed. Each note is written once. If the EHR does not accept a note, you get its text to copy.</p>
          </ConfirmDialog>
        </div>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </section>
  );
}
