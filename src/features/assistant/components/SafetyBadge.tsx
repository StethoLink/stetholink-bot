import type { SafetyLevel } from "@/shared/contracts";

const LABELS: Record<SafetyLevel, { icon: string; text: string; className: string }> = {
  ok: { icon: "✓", text: "Safety: no issues flagged", className: "border-emerald-700 text-emerald-800 bg-emerald-50" },
  caution: { icon: "!", text: "Safety: caution", className: "border-amber-700 text-amber-900 bg-amber-50" },
  blocked: { icon: "✕", text: "Safety: blocked", className: "border-red-700 text-red-800 bg-red-50" },
};

/** Safety level shown with an icon and text, so meaning never depends on color alone. */
export function SafetyBadge({ level }: { level: SafetyLevel }) {
  const l = LABELS[level];
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-medium ${l.className}`}>
      <span aria-hidden="true">{l.icon}</span>
      {l.text}
    </span>
  );
}
