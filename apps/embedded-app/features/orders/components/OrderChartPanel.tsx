"use client";

import { useEffect, useState } from "react";
import type { ChartWriteResult, ChartWriteStatus, OrderDraft } from "@/shared/contracts";
import { Alert, Badge, Button, Card, CardHeader, ConfirmDialog, Skeleton, type Tone } from "@/apps/embedded-app/components/ui";
import { useT } from "@/apps/embedded-app/i18n/client";
import { DeliveryError } from "@/apps/embedded-app/features/consultations/hooks/deliveryState";
import { ordersApi } from "../hooks/ordersApi";
import { copyToClipboard } from "../hooks/orderText";

const TONE: Record<ChartWriteStatus, Tone> = { created: "success", existing: "success", pending: "neutral", failed: "danger", unsupported: "warning" };
const inChart = (result: ChartWriteResult | undefined) => result?.status === "created" || result?.status === "existing";

/** Reads what of the approved orders is in the chart, and shows it. Nothing is shown for a draft with no approved order. */
export function OrderChartPanel({ draft, canWrite }: { draft: OrderDraft; canWrite: boolean }) {
  const { t } = useT();
  const c = t.work.orders.chart;
  const approved = draft.lines.filter((line) => line.status === "approved").length;
  const [results, setResults] = useState<ChartWriteResult[]>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!approved) return;
    let active = true;
    setError("");
    void ordersApi.chart(draft.id).then((list) => active && setResults(list)).catch((failure: unknown) => active && setError(failure instanceof DeliveryError ? failure.message : c.error));
    return () => { active = false; };
  }, [draft.id, draft.version, approved, attempt, c.error]);

  return <OrderChartView draft={draft} canWrite={canWrite} results={results} error={error} onRetry={() => setAttempt((value) => value + 1)} onResults={setResults} />;
}

/**
 * The approved orders and what of them is in the patient's chart. A physician writes them to the EHR (each is created once). Where the EHR
 * cannot receive an order, or the write failed, the order is shown as text to enter by hand, with a button to copy it.
 */
export function OrderChartView({ draft, canWrite, results, error, onRetry, onResults }: {
  draft: OrderDraft;
  /** A physician with the write scope. Without it the orders are shown as text only. */
  canWrite: boolean;
  /** The statuses read from the server; undefined while they load. */
  results?: ChartWriteResult[];
  error?: string;
  onRetry?(): void;
  onResults?(results: ChartWriteResult[]): void;
}) {
  const { t } = useT();
  const o = t.work.orders;
  const c = o.chart;
  const approved = draft.lines.filter((line) => line.status === "approved");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState("");
  const [copy, setCopy] = useState<boolean>();

  if (!approved.length) return null;
  const rows = approved.map((line) => ({ line, result: results?.find((entry) => entry.item === line.id) }));
  const waiting = rows.filter((row) => !inChart(row.result));
  const copyable = waiting.flatMap((row) => row.result?.copyText ? [row.result.copyText] : []);
  const cannot = rows.some((row) => row.result?.status === "unsupported");
  const failed = rows.some((row) => row.result?.status === "failed");

  async function write() {
    setBusy(true);
    setWriteError("");
    try {
      onResults?.(await ordersApi.write(draft.id));
      setConfirming(false);
    } catch (failure) {
      setWriteError(failure instanceof DeliveryError ? failure.message : c.writeError);
    } finally {
      setBusy(false);
    }
  }
  const doCopy = async (text: string) => setCopy(await copyToClipboard(text));

  return (
    <Card aria-label={c.heading} className="space-y-3">
      <CardHeader title={c.heading} description={c.intro} level={3} />
      {error ? (
        <Alert tone="danger" action={onRetry && <Button size="sm" onClick={onRetry}>{t.common.retry}</Button>}>{error}</Alert>
      ) : results === undefined ? <Skeleton label={c.loading} lines={2} /> : (
        <>
          {cannot && <Alert tone="warning" role="alert" title={c.cannotTitle}>{c.cannotText}</Alert>}
          {failed && <Alert tone="danger">{c.failedText}</Alert>}
          <ul className="space-y-2">
            {rows.map(({ line, result }) => {
              const status = result?.status ?? "pending";
              return (
                <li key={line.id} className="space-y-1.5 rounded-md border border-slate-200 p-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                    <Badge>{o.kinds[line.kind]}</Badge>
                    <Badge tone={TONE[status]} dot>{c.status[status]}</Badge>
                  </div>
                  <p className="text-sm font-medium break-words"><bdi>{line.display}</bdi></p>
                  {result?.status === "failed" && result.failure && <p className="text-xs text-slate-700">{c.serverDetail} <span dir="auto">{result.failure}</span></p>}
                  {!inChart(result) && result?.copyText && (
                    <div className="space-y-1">
                      {(status === "unsupported" || status === "failed") && (
                        <>
                          <p className="text-xs text-slate-700">{c.textLabel}</p>
                          <p dir="ltr" className="w-full rounded bg-slate-50 p-1.5 text-sm break-words select-all">{result.copyText}</p>
                        </>
                      )}
                      <Button size="sm" onClick={() => void doCopy(result.copyText!)}>{c.copy}</Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            {canWrite && waiting.length > 0 && <Button variant="primary" onClick={() => setConfirming(true)}>{c.write}</Button>}
            {copyable.length > 1 && <Button onClick={() => void doCopy(copyable.join("\n"))}>{c.copyAll}</Button>}
          </div>
          {!canWrite && waiting.length > 0 && <p className="text-sm text-slate-700" role="status">{c.onlyPhysician}</p>}
          {copy !== undefined && <p role="status" className="text-xs text-slate-700">{copy ? c.copied : c.copyFailed}</p>}
          <ConfirmDialog open={confirming} onClose={() => setConfirming(false)} onConfirm={() => void write()} busy={busy} error={writeError} title={c.writeTitle} confirmLabel={c.writeConfirm}>
            <p className="font-medium">{c.writeIntro}</p>
            <ul className="list-disc space-y-0.5 ps-5 text-slate-800">
              {waiting.map(({ line }) => <li key={line.id} className="break-words"><bdi>{line.display}</bdi></li>)}
            </ul>
            <p className="text-xs text-slate-700">{c.writeNote}</p>
          </ConfirmDialog>
        </>
      )}
    </Card>
  );
}
