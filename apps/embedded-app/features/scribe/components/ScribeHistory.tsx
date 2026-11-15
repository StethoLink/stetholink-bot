"use client";
import { useEffect, useState } from "react";
import type { ScribeSessionSummary, ScribeStatus } from "@/shared/contracts";
import { Badge, Card, CardHeader, type Tone } from "@/apps/embedded-app/components/ui";
import { scribeApi } from "../hooks/scribeApi";

const STATUS: Record<ScribeStatus, { text: string; tone: Tone }> = {
  recording: { text: "Recording interrupted", tone: "warning" }, transcribed: { text: "Note not written yet", tone: "warning" }, note_ready: { text: "Awaiting physician review", tone: "warning" },
  approved: { text: "Approved, not in the chart", tone: "primary" }, written: { text: "In the chart", tone: "success" }, discarded: { text: "Discarded", tone: "neutral" },
};

/** Visits recorded for this chart. Hidden when there are none or the scribe is off. */
export function ScribeHistory({ onOpen }: { onOpen(sessionId: string): void }) {
  const [items, setItems] = useState<ScribeSessionSummary[]>([]);
  useEffect(() => {
    let active = true;
    void scribeApi.list().then((list) => active && setItems(list)).catch(() => undefined);
    return () => { active = false; };
  }, []);
  if (!items.length) return null;
  return (
    <Card aria-label="Recorded visits">
      <CardHeader title="Recorded visits" description="Visit notes drafted by the scribe for this chart." />
      <ul className="divide-y divide-slate-200">
        {items.map((item) => (
          <li key={item.id}>
            <button type="button" onClick={() => onOpen(item.id)} className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-1 py-2 text-start text-sm hover:bg-slate-50">
              <span className="font-medium text-slate-900">Visit note</span>
              <Badge tone={STATUS[item.status].tone} dot>{STATUS[item.status].text}</Badge>
              <span className="ms-auto text-xs text-slate-700">{new Date(item.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
