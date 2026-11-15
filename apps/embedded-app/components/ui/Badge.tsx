import type { ReactNode } from "react";

export type Tone = "neutral" | "primary" | "success" | "warning" | "danger" | "ai";
export function Badge({ tone = "neutral", dot = false, children, title }: { tone?: Tone; dot?: boolean; children: ReactNode; title?: string }) {
  return <span className={`badge badge-${tone}${dot ? " badge-dot" : ""}`} title={title}>{children}</span>;
}
/** Marks content a language model wrote. Every such block carries it. */
export function AiBadge({ children = "AI-generated" }: { children?: ReactNode }) {
  return <Badge tone="ai">{children}</Badge>;
}
/** Whose data this is: real patients of a live tenant, or fictional test patients. */
export function DataBadge({ classification }: { classification: "live" | "synthetic" }) {
  return classification === "live"
    ? <Badge tone="primary" dot>Real patient data</Badge>
    : <Badge tone="warning" dot>Synthetic data</Badge>;
}
