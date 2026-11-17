"use client";

import { useEffect, useRef, useState } from "react";
import type { OrderDraftSummary, OrderNoMatch } from "@/shared/contracts";
import { AiBadge, Alert, Badge, Button, Card, CardHeader, EmptyState, Skeleton, WorkInProgress } from "@/apps/embedded-app/components/ui";
import { useT } from "@/apps/embedded-app/i18n/client";
import { formatDateTime } from "@/apps/embedded-app/i18n/format";
import { CancelledError, DeliveryError } from "@/apps/embedded-app/features/consultations/hooks/deliveryState";
import type { AssistantInfo } from "@/apps/embedded-app/features/consultations";
import { ordersApi } from "../hooks/ordersApi";
import { OrderReview, type OrderAccess } from "./OrderReview";

/** The draft's counts as small badges, only for what is not zero. */
function Counts({ item }: { item: OrderDraftSummary }) {
  const { t } = useT();
  const c = t.work.orders.history.counts;
  return (
    <span className="flex flex-wrap gap-1">
      <Badge>{c.total}: {item.lines}</Badge>
      {item.pending > 0 && <Badge tone="warning">{c.pending}: {item.pending}</Badge>}
      {item.approved > 0 && <Badge tone="success">{c.approved}: {item.approved}</Badge>}
      {item.rejected > 0 && <Badge tone="danger">{c.rejected}: {item.rejected}</Badge>}
    </span>
  );
}

/** What the physician's words matched nothing of: no draft, nothing stored. They can change the request and try again. */
function NoMatch({ result, onChange }: { result: OrderNoMatch; onChange(): void }) {
  const { t } = useT();
  const n = t.work.orders.noMatch;
  return (
    <section aria-label={n.aria} className="alert alert-warning space-y-2">
      <h3 className="text-base font-semibold">{n.title}</h3>
      <p className="text-sm break-words"><span className="font-medium">{n.yourRequest}</span> <span dir="auto">{result.request}</span></p>
      <p className="text-xs">{n.nothingSaved}</p>
      {result.unmatched.length > 0 && (
        <div>
          <h4 className="section-title">{n.unmatchedHeading}</h4>
          <ul className="list-disc ps-5 text-sm">{result.unmatched.map((phrase, index) => <li key={index} className="break-words" dir="auto">{phrase}</li>)}</ul>
        </div>
      )}
      {result.rejectedLines > 0 && <p className="text-sm">{n.dropped(result.rejectedLines)}</p>}
      <p className="text-xs">{n.hint}</p>
      <Button onClick={onChange}>{n.change}</Button>
    </section>
  );
}

/**
 * The Orders tab: say what to order in your own words, review the drafted orders, decide, and write the approved ones to the chart
 * or enter them by hand. Without the hospital's order catalog the server answers 501 and this says so; nothing is offered then.
 */
export function OrderComposer({ access, assistant, openDraftId, onOpenDraft }: {
  access: OrderAccess;
  assistant?: AssistantInfo;
  /** The order draft being reviewed, when the parent holds it. */
  openDraftId?: string;
  onOpenDraft?(draftId: string | undefined): void;
}) {
  const { t, locale } = useT();
  const o = t.work.orders;
  const [ownDraftId, setOwnDraftId] = useState<string>();
  const draftId = onOpenDraft ? openDraftId : ownDraftId;
  const setDraftId = onOpenDraft ?? setOwnDraftId;
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [noMatch, setNoMatch] = useState<OrderNoMatch>();
  const [notSetUp, setNotSetUp] = useState(false);
  const [items, setItems] = useState<OrderDraftSummary[]>();
  const [listError, setListError] = useState("");
  const [attempt, setAttempt] = useState(0);
  // One key per exact request: pressing the button again after a timeout returns the draft if the server finished it, instead of a second one.
  const key = useRef<{ text: string; id: string }>(undefined);
  const abort = useRef<AbortController>(undefined);
  useEffect(() => () => abort.current?.abort(), []);

  // The earlier drafts of this visit. A 501 here is the first sign that the hospital has no order catalog.
  useEffect(() => {
    if (!access.draft || draftId) return;
    let active = true;
    setListError("");
    void ordersApi.list().then((list) => { if (active) { setItems(list); setNotSetUp(false); } })
      .catch((failure: unknown) => {
        if (!active) return;
        if (failure instanceof DeliveryError && failure.status === 501) setNotSetUp(true);
        else setListError(failure instanceof DeliveryError ? failure.message : o.history.error);
      });
    return () => { active = false; };
  }, [access.draft, draftId, attempt, o.history.error]);

  async function prepare(text = request) {
    const trimmed = text.trim();
    if (trimmed.length < 2 || busy) return;
    if (key.current?.text !== trimmed) key.current = { text: trimmed, id: crypto.randomUUID() };
    abort.current = new AbortController();
    setBusy(true);
    setError("");
    try {
      const result = await ordersApi.create({ request: trimmed, idempotencyKey: key.current.id }, abort.current.signal);
      key.current = undefined;
      if ("outcome" in result) {
        setNoMatch(result);
        return;
      }
      setNoMatch(undefined);
      setRequest("");
      setDraftId(result.id);
    } catch (failure) {
      // After a cancel the same key is kept, so pressing the button again returns the draft if the server finished it.
      if (failure instanceof DeliveryError && failure.status === 501) setNotSetUp(true);
      else setError(failure instanceof CancelledError ? "" : failure instanceof DeliveryError ? failure.message : o.composer.error);
    } finally {
      setBusy(false);
    }
  }

  if (!access.draft) {
    return <Alert tone="warning" role="alert" title={o.noPermission.title}>{o.noPermission.text}</Alert>;
  }
  if (draftId) {
    return (
      <section aria-label={o.sectionLabel} className="space-y-3">
        <Button variant="ghost" size="sm" onClick={() => setDraftId(undefined)}>{o.newRequest}</Button>
        <OrderReview draftId={draftId} access={access} />
      </section>
    );
  }
  if (notSetUp) {
    return <Alert tone="info" role="status" title={o.notSetUp.title}>{o.notSetUp.text}</Alert>;
  }
  return (
    <section aria-label={o.sectionLabel} className="space-y-3">
      <Card aria-label={o.composer.title} className="space-y-3">
        <CardHeader title={o.composer.title} actions={assistant ? <AiBadge>{o.composer.aiAssisted}</AiBadge> : undefined} description={o.composer.description} />
        {busy ? (
          <WorkInProgress label={o.composer.busy} steps={o.composer.steps} onCancel={() => abort.current?.abort()} />
        ) : noMatch ? (
          <NoMatch result={noMatch} onChange={() => { setRequest(noMatch.request); setNoMatch(undefined); setError(""); }} />
        ) : (
          <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void prepare(); }}>
            <label className="field-label" htmlFor="order-request">{o.composer.requestLabel}</label>
            <textarea id="order-request" rows={3} value={request} onChange={(event) => setRequest(event.target.value)} maxLength={2000} className="field" dir="auto"
              onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void prepare(); } }}
              placeholder={o.composer.placeholder} />
            <div className="flex flex-wrap gap-1.5">
              {o.composer.examples.map((example) => (
                <button key={example} type="button" onClick={() => setRequest(example)}
                  className="rounded-full border border-slate-300 bg-white px-2.5 py-1 text-start text-xs text-slate-800 hover:bg-slate-100">{example}</button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="submit" disabled={request.trim().length < 2} className="btn btn-primary">{o.composer.prepare}</button>
              <span className="text-xs text-slate-600" dir="ltr">{t.work.composer.ctrlEnter}</span>
            </div>
            <p className="text-xs text-slate-700">{o.composer.help}</p>
          </form>
        )}
        {error && !busy && <Alert tone="danger">{error}</Alert>}
      </Card>

      <Card aria-label={o.history.title}>
        <CardHeader title={o.history.title} description={o.history.description} />
        {listError ? (
          <Alert tone="danger" action={<Button size="sm" onClick={() => setAttempt((value) => value + 1)}>{t.common.retry}</Button>}>{listError}</Alert>
        ) : items === undefined ? <Skeleton label={o.history.loading} lines={2} /> : items.length === 0 ? (
          <EmptyState title={o.history.emptyTitle}>{o.history.empty}</EmptyState>
        ) : (
          <ul className="divide-y divide-slate-200">
            {items.map((item) => (
              <li key={item.id}>
                <button type="button" onClick={() => setDraftId(item.id)} className="flex w-full flex-col gap-1 px-1 py-2 text-start text-sm hover:bg-slate-50">
                  <span className="line-clamp-2 font-medium text-slate-900 break-words" dir="auto">{item.request}</span>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Badge tone="primary">{o.history.modes[item.mode]}</Badge>
                    <Counts item={item} />
                    <span className="ms-auto text-xs text-slate-700">{formatDateTime(item.updatedAt, locale)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
