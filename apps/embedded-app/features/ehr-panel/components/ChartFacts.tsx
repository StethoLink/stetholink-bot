"use client";
import type { ClinicalFact, ClinicalFactCategory } from "@/shared/contracts";
import { useT } from "@/apps/embedded-app/i18n/client";
import type { ChartPart, Messages } from "@/apps/embedded-app/i18n/messages";

const GROUPS: { key: keyof Messages["chart"]["groups"]; categories: ClinicalFactCategory[] }[] = [
  { key: "symptoms", categories: ["symptom"] },
  { key: "examination", categories: ["vital_sign"] },
  { key: "investigations", categories: ["investigation"] },
  { key: "history", categories: ["problem", "history"] },
  { key: "medications", categories: ["medication", "allergy"] },
];
const PART: Partial<Record<ClinicalFactCategory, ChartPart>> = {
  allergy: "allergy", problem: "problem", medication: "medication", vital_sign: "observation", investigation: "observation", symptom: "observation",
};

/**
 * The parts of the chart the EHR did not hand over: a search it refused, usually because the
 * registration does not grant that resource. The connector marks them; they are never an empty list.
 */
export function partsNotShared(facts: ClinicalFact[] | undefined): ChartPart[] {
  const parts = (facts ?? [])
    .filter((fact) => fact.status === "unknown" && fact.source.reference.endsWith("/not-loaded"))
    .map((fact) => PART[fact.category])
    .filter((part): part is ChartPart => !!part);
  return [...new Set(parts)];
}

export function factValue(fact: ClinicalFact, t: Messages["chart"]) {
  if (fact.status === "unknown") return t.unavailable[fact.reason] ?? t.notAvailable;
  if (typeof fact.value === "boolean") return fact.value ? t.documented : t.documentedAbsent;
  return `${String(fact.value)}${fact.unit ? ` ${fact.unit}` : ""}`;
}

/** The normalized chart record the assistant reads. Unknown items are shown as unknown, never as normal. */
export function ChartFacts({ facts }: { facts: ClinicalFact[] }) {
  const { t } = useT();
  if (!facts.length) return null;
  const unavailable = facts.filter((fact) => fact.status === "unknown").length;
  return (
    <details className="mt-3 rounded-md border border-slate-200 p-2.5" open>
      <summary className="cursor-pointer text-sm font-semibold">{t.chart.record(facts.length - unavailable, unavailable)}</summary>
      <div className="mt-2 space-y-2">
        {GROUPS.map((group) => {
          const items = facts.filter((fact) => group.categories.includes(fact.category));
          if (!items.length) return null;
          return (
            <section key={group.key}>
              <h3 className="section-title">{t.chart.groups[group.key]}</h3>
              <ul className="text-sm">
                {items.map((fact) => (
                  <li key={fact.id} className="break-words">
                    <bdi className="font-medium">{fact.label}:</bdi>{" "}
                    <bdi className={fact.status === "unknown" ? "text-amber-900 italic" : undefined}>{factValue(fact, t.chart)}</bdi>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </details>
  );
}

/** Says plainly which records the EHR withheld, what that means for a draft and who can change it. */
export function NotSharedNotice({ facts, className = "" }: { facts: ClinicalFact[] | undefined; className?: string }) {
  const { t } = useT();
  const parts = partsNotShared(facts);
  if (!parts.length) return null;
  return (
    <div role="alert" data-state="not-shared" className={`alert alert-warning ${className}`.trim()}>
      <p className="font-semibold">{t.chart.notSharedTitle}</p>
      <p>{t.chart.notSharedText(parts.map((part) => t.chart.parts[part]).join(t.chart.parts.allergy === "allergies" ? ", " : "، "))}</p>
      <p className="mt-1 text-xs">{t.chart.notSharedAdmin}</p>
    </div>
  );
}
