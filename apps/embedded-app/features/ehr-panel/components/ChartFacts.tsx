import type { ClinicalFact, ClinicalFactCategory } from "@/shared/contracts";

const GROUPS: { title: string; categories: ClinicalFactCategory[] }[] = [
  { title: "Symptoms", categories: ["symptom"] },
  { title: "Examination", categories: ["vital_sign"] },
  { title: "Investigations", categories: ["investigation"] },
  { title: "History and problems", categories: ["problem", "history"] },
  { title: "Medications and allergies", categories: ["medication", "allergy"] },
];
const UNAVAILABLE: Record<string, string> = {
  not_recorded: "not recorded", not_provided: "not provided", not_performed: "not performed", pending: "result pending",
};

export function factValue(fact: ClinicalFact) {
  if (fact.status === "unknown") return UNAVAILABLE[fact.reason] ?? "not available";
  if (typeof fact.value === "boolean") return fact.value ? "documented" : "documented as absent";
  return `${String(fact.value)}${fact.unit ? ` ${fact.unit}` : ""}`;
}

/** The normalized chart record the assistant reads. Unknown items are shown as unknown, never as normal. */
export function ChartFacts({ facts }: { facts: ClinicalFact[] }) {
  if (!facts.length) return null;
  const unavailable = facts.filter((fact) => fact.status === "unknown").length;
  return (
    <details className="mt-3 rounded border border-slate-300 p-2" open>
      <summary className="cursor-pointer text-sm font-semibold">
        Chart record ({facts.length - unavailable} documented{unavailable ? `, ${unavailable} not available` : ""})
      </summary>
      <div className="mt-2 space-y-2">
        {GROUPS.map((group) => {
          const items = facts.filter((fact) => group.categories.includes(fact.category));
          if (!items.length) return null;
          return (
            <section key={group.title}>
              <h3 className="text-xs font-semibold tracking-wide text-slate-700 uppercase">{group.title}</h3>
              <ul className="text-sm">
                {items.map((fact) => (
                  <li key={fact.id} className="break-words">
                    <span className="font-medium">{fact.label}:</span>{" "}
                    <span className={fact.status === "unknown" ? "text-amber-900 italic" : undefined}>{factValue(fact)}</span>
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
