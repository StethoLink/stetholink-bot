"use client";
import { useT } from "@/apps/embedded-app/i18n/client";
import type { ReactNode } from "react";

export type Tone = "neutral" | "primary" | "success" | "warning" | "danger" | "ai";
export function Badge({ tone = "neutral", dot = false, children, title }: { tone?: Tone; dot?: boolean; children: ReactNode; title?: string }) {
  return <span className={`badge badge-${tone}${dot ? " badge-dot" : ""}`} title={title}>{children}</span>;
}
/** Marks content a language model wrote. Every such block carries it. */
export function AiBadge({ children }: { children?: ReactNode }) {
  const { t } = useT();
  return <Badge tone="ai">{children ?? t.data.aiGenerated}</Badge>;
}
/** Whose data this is: real patients of a live tenant, or fictional test patients. */
export function DataBadge({ classification }: { classification: "live" | "synthetic" }) {
  const { t } = useT();
  return classification === "live"
    ? <Badge tone="primary" dot>{t.data.live}</Badge>
    : <Badge tone="warning" dot>{t.data.synthetic}</Badge>;
}
