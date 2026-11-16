"use client";
import { useEffect, useState } from "react";
import type { ScribeSessionSummary, ScribeStatus } from "@/shared/contracts";
import { Badge, Card, CardHeader, type Tone } from "@/apps/embedded-app/components/ui";
import { useT } from "@/apps/embedded-app/i18n/client";
import { formatDateTime } from "@/apps/embedded-app/i18n/format";
import { scribeApi } from "../hooks/scribeApi";

const TONE: Record<ScribeStatus, Tone> = { recording: "warning", transcribed: "warning", note_ready: "warning", approved: "primary", written: "success", discarded: "neutral" };

/** Visits recorded for this chart. Hidden when there are none or the scribe is off. */
export function ScribeHistory({ onOpen }: { onOpen(sessionId: string): void }) {
  const { t, locale } = useT();
  const [items, setItems] = useState<ScribeSessionSummary[]>([]);
  useEffect(() => {
    let active = true;
    void scribeApi.list().then((list) => active && setItems(list)).catch(() => undefined);
    return () => { active = false; };
  }, []);
  if (!items.length) return null;
  return (
    <Card aria-label={t.work.scribeHistory.title}>
      <CardHeader title={t.work.scribeHistory.title} description={t.work.scribeHistory.description} />
      <ul className="divide-y divide-slate-200">
        {items.map((item) => (
          <li key={item.id}>
            <button type="button" onClick={() => onOpen(item.id)} className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-1 py-2 text-start text-sm hover:bg-slate-50">
              <span className="font-medium text-slate-900">{t.work.scribeHistory.visitNote}</span>
              <Badge tone={TONE[item.status]} dot>{t.work.scribeHistory.status[item.status]}</Badge>
              <span className="ms-auto text-xs text-slate-700">{formatDateTime(item.createdAt, locale)}</span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
