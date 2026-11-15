"use client";
import { useEffect, useState } from "react";
import type { ConsultationListItem } from "@/shared/contracts";
import { Card, CardHeader, EmptyState, Skeleton } from "@/apps/embedded-app/components/ui";
import { deliveryApi } from "../hooks/deliveryState";
import { DraftStatusBadge } from "./DraftStatusBadge";

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Consultations already prepared for this chart, newest first. Selecting one opens it for review. */
export function ConsultationHistory({ onOpen }: { onOpen(draftId: string): void }) {
  const [items, setItems] = useState<ConsultationListItem[]>();
  useEffect(() => {
    let active = true;
    void deliveryApi.list().then((list) => active && setItems(list)).catch(() => active && setItems([]));
    return () => { active = false; };
  }, []);
  return (
    <Card aria-label="Consultations for this chart">
      <CardHeader title="Consultations for this chart" description="Drafts, approved consultations and specialist replies for this visit." />
      {items === undefined ? <Skeleton label="Loading consultations" lines={3} /> : items.length === 0 ? (
        <EmptyState title="None yet.">Consultations you prepare for this visit appear here.</EmptyState>
      ) : (
        <ul className="divide-y divide-slate-200">
          {items.map((item) => (
            <li key={item.id}>
              <button type="button" onClick={() => onOpen(item.id)} className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-1 py-2 text-start text-sm hover:bg-slate-50">
                <span className="font-medium text-slate-900">{item.specialty ?? "Specialty not set"}</span>
                <DraftStatusBadge status={item.status} />
                <span className="ms-auto text-xs text-slate-700">{when(item.updatedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
