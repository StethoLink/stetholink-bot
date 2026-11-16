"use client";
import { useEffect, useState } from "react";
import type { ConsultationListItem } from "@/shared/contracts";
import { Alert, Button, Card, CardHeader, EmptyState, Skeleton } from "@/apps/embedded-app/components/ui";
import { useT } from "@/apps/embedded-app/i18n/client";
import { formatDateTime } from "@/apps/embedded-app/i18n/format";
import { DeliveryError, deliveryApi } from "../hooks/deliveryState";
import { DraftStatusBadge } from "./DraftStatusBadge";

/** Consultations already prepared for this chart, newest first. Selecting one opens it for review. */
export function ConsultationHistory({ onOpen }: { onOpen(draftId: string): void }) {
  const { t, locale } = useT();
  const [items, setItems] = useState<ConsultationListItem[]>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError(undefined);
    // A list that could not be loaded is an error with its reference, never an empty history.
    void deliveryApi.list().then((list) => active && setItems(list))
      .catch((failure: unknown) => active && setError(failure instanceof DeliveryError ? failure.message : t.work.history.error));
    return () => { active = false; };
  }, [attempt, t.work.history.error]);
  return (
    <Card aria-label={t.work.history.title}>
      <CardHeader title={t.work.history.title} description={t.work.history.description} />
      {error ? (
        <Alert tone="danger" action={<Button size="sm" onClick={() => setAttempt((value) => value + 1)}>{t.common.retry}</Button>}>{error}</Alert>
      ) : items === undefined ? <Skeleton label={t.work.history.loading} lines={3} /> : items.length === 0 ? (
        <EmptyState title={t.work.history.emptyTitle}>{t.work.history.empty}</EmptyState>
      ) : (
        <ul className="divide-y divide-slate-200">
          {items.map((item) => (
            <li key={item.id}>
              <button type="button" onClick={() => onOpen(item.id)} className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-1 py-2 text-start text-sm hover:bg-slate-50">
                <span className="font-medium text-slate-900"><bdi>{item.specialty ?? t.work.history.specialtyNotSet}</bdi></span>
                <DraftStatusBadge status={item.status} />
                <span className="ms-auto text-xs text-slate-700">{formatDateTime(item.updatedAt, locale)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
