"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { OrderDraft } from "@/shared/contracts";
import { Alert, Button, Card, ConfirmDialog, Skeleton, useToast } from "@/apps/embedded-app/components/ui";
import { useT } from "@/apps/embedded-app/i18n/client";
import { DeliveryError } from "@/apps/embedded-app/features/consultations/hooks/deliveryState";
import { ordersApi } from "../hooks/ordersApi";
import { decisionsToRecord, type LineChoice } from "../hooks/orderText";
import { OrderChartPanel } from "./OrderChartPanel";
import { OrderDraftView } from "./OrderDraftView";

/** What the signed-in session may do with orders. The server decides again on every request; this only decides what is offered. */
export interface OrderAccess {
  /** Prepare orders and read one's own drafts (`order:draft`). */
  draft: boolean;
  /** Approve or reject (a physician with `order:approve`). */
  approve: boolean;
  /** Write approved orders to the EHR (a physician with `order:approve` and `chart:write`). */
  write: boolean;
}

/** Loads a drafted set of orders and shows it for review. */
export function OrderReview({ draftId, access }: { draftId: string; access: OrderAccess }) {
  const { t } = useT();
  const o = t.work.orders;
  const [draft, setDraft] = useState<OrderDraft>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(async () => {
    try {
      setDraft(await ordersApi.get(draftId));
      setError("");
    } catch (failure) {
      setError(failure instanceof DeliveryError ? failure.message : o.review.error);
    }
  }, [draftId, o.review.error]);
  useEffect(() => { void load(); }, [load, attempt]);

  if (error && !draft) {
    return (
      <Card aria-label={o.review.error}>
        <Alert tone="danger" action={<Button size="sm" onClick={() => setAttempt((value) => value + 1)}>{t.common.retry}</Button>}>{error}</Alert>
      </Card>
    );
  }
  if (!draft) return <Card aria-label={o.review.loading}><Skeleton label={o.review.loading} lines={4} /></Card>;
  return <OrderReviewLoaded draft={draft} access={access} onDraft={setDraft} onReload={load} />;
}

/**
 * A loaded draft for a physician or a nurse. A physician chooses approve or reject on each order, confirms, and then writes the approved
 * orders to the chart or enters them by hand; anyone else reads the draft and is told that a physician must approve it.
 */
export function OrderReviewLoaded({ draft, access, onDraft, onReload }: { draft: OrderDraft; access: OrderAccess; onDraft(next: OrderDraft): void; onReload(): Promise<void> | void }) {
  const { t } = useT();
  const o = t.work.orders;
  const toast = useToast();
  const [choices, setChoices] = useState<Record<string, LineChoice | undefined>>({});
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [notice, setNotice] = useState("");
  // One key per exact set of decisions on one version of the draft: pressing again after a timeout cannot decide twice.
  const key = useRef<{ fingerprint: string; id: string }>(undefined);

  const pending = draft.lines.filter((line) => line.status === "pending");
  const { decisions, incomplete } = decisionsToRecord(draft.lines, choices);
  const approving = decisions.filter((entry) => entry.decision === "approve");
  const rejecting = decisions.filter((entry) => entry.decision === "reject");
  const nameOf = (lineId: string) => draft.lines.find((line) => line.id === lineId)?.display ?? "";

  async function record() {
    if (!decisions.length || busy) return;
    const fingerprint = JSON.stringify([draft.version, decisions]);
    if (key.current?.fingerprint !== fingerprint) key.current = { fingerprint, id: crypto.randomUUID() };
    setBusy(true);
    setProblem("");
    try {
      const next = await ordersApi.decide({ draftId: draft.id, expectedVersion: draft.version, idempotencyKey: key.current.id, decisions });
      key.current = undefined;
      onDraft(next);
      setChoices({});
      setConfirming(false);
      setNotice("");
      toast(o.decide.recorded);
    } catch (failure) {
      if (failure instanceof DeliveryError && failure.status === 409) {
        // The draft changed meanwhile (this physician decided in another window): show it as it is now and let them decide again.
        key.current = undefined;
        setConfirming(false);
        setChoices({});
        setNotice(o.decide.changed);
        await onReload();
      } else {
        setProblem(failure instanceof DeliveryError ? failure.message : o.decide.error);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label={o.sectionLabel} className="space-y-3">
      <div className="card card-pad space-y-4">
        {notice && <Alert tone="warning" role="alert">{notice}</Alert>}
        <OrderDraftView draft={draft} choices={access.approve ? choices : undefined}
          onChoice={access.approve ? (lineId, next) => setChoices((current) => ({ ...current, [lineId]: next })) : undefined} />
        {pending.length > 0 && !access.approve && <p role="status" className="text-sm text-slate-700">{o.review.mustApprove}</p>}
        {pending.length > 0 && access.approve && (
          <section aria-label={o.decide.heading} className="space-y-2 border-t border-slate-200 pt-3">
            <h3 className="text-sm font-semibold">{o.decide.heading}</h3>
            <p className="text-xs text-slate-700">{o.decide.intro}</p>
            <Button variant="primary" disabled={!decisions.length || busy} onClick={() => setConfirming(true)}>{o.decide.record}</Button>
            {!decisions.length && incomplete === 0 && <p className="text-xs text-slate-700">{o.decide.recordHint}</p>}
            {incomplete > 0 && <p className="text-xs text-amber-950" role="status">{o.decide.recordBlocked}</p>}
          </section>
        )}
      </div>
      <OrderChartPanel draft={draft} canWrite={access.write} />
      <ConfirmDialog open={confirming} onClose={() => setConfirming(false)} onConfirm={() => void record()} busy={busy} error={problem} canConfirm={decisions.length > 0}
        title={o.decide.confirmTitle} confirmLabel={o.decide.confirm} variant="primary">
        {approving.length > 0 && (
          <div>
            <p className="font-medium">{o.decide.confirmApprove}</p>
            <ul className="list-disc space-y-0.5 ps-5 text-slate-800">{approving.map((entry) => <li key={entry.lineId} className="break-words"><bdi>{nameOf(entry.lineId)}</bdi></li>)}</ul>
          </div>
        )}
        {rejecting.length > 0 && (
          <div>
            <p className="font-medium">{o.decide.confirmReject}</p>
            <ul className="list-disc space-y-0.5 ps-5 text-slate-800">{rejecting.map((entry) => <li key={entry.lineId} className="break-words"><bdi>{nameOf(entry.lineId)}</bdi></li>)}</ul>
          </div>
        )}
        <ul className="list-disc space-y-0.5 ps-5 text-xs text-slate-700">{o.decide.confirmBullets.map((line) => <li key={line}>{line}</li>)}</ul>
      </ConfirmDialog>
    </section>
  );
}
