import type { PatientContext } from "@/shared/contracts";
import { SyntheticBadge } from "./StateViews";

function age(birthDate?: string): string | undefined {
  if (!birthDate) return undefined;
  const b = new Date(birthDate);
  if (Number.isNaN(b.getTime())) return undefined;
  const now = new Date();
  let years = now.getUTCFullYear() - b.getUTCFullYear();
  const m = now.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < b.getUTCDate())) years--;
  return `${years} y`;
}

const SEX: Record<PatientContext["sex"], string> = { male: "Male", female: "Female", other: "Other", unknown: "Sex unknown" };

function List({ items, empty }: { items: string[]; empty: string }) {
  if (!items.length) return <p className="text-sm text-slate-700">{empty}</p>;
  return (
    <ul className="list-disc space-y-0.5 pl-5 text-sm">
      {items.map((x) => (
        <li key={x} className="break-words">
          {x}
        </li>
      ))}
    </ul>
  );
}

/** Patient summary. Allergies come first and are never truncated. */
export function PatientContextView({ patient, compact = false }: { patient: PatientContext; compact?: boolean }) {
  const p = patient;
  const hasAllergies = p.allergies.length > 0;
  const demographics = [SEX[p.sex], age(p.birthDate), p.birthDate && `DOB ${p.birthDate}`].filter(Boolean).join(" · ");

  return (
    <section aria-labelledby={`pt-${p.patientId}`} className={`rounded-lg border border-slate-200 bg-white ${compact ? "p-3" : "p-4"}`}>
      <header className="flex flex-wrap items-center gap-2">
        <h2 id={`pt-${p.patientId}`} className="text-base font-semibold break-words">
          {p.displayName}
        </h2>
        {p.source === "synthetic" && <SyntheticBadge />}
      </header>
      {demographics && <p className="text-xs text-slate-700">{demographics}</p>}

      <div
        role="note"
        aria-label="Allergies"
        className={`mt-3 rounded border-2 p-2 ${hasAllergies ? "border-red-700 bg-red-50 text-red-900" : "border-slate-500 bg-slate-50 text-slate-900"}`}
      >
        <p className="text-sm font-bold">
          <span aria-hidden="true">{hasAllergies ? "⚠ " : "ⓘ "}</span>
          {hasAllergies ? `Allergies (${p.allergies.length})` : "Allergies"}
        </p>
        {hasAllergies ? (
          <ul className="mt-1 flex flex-wrap gap-1">
            {p.allergies.map((a) => (
              <li key={a} className="rounded bg-white px-1.5 py-0.5 text-sm font-semibold break-words">
                {a}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm">None recorded. Confirm with the patient before prescribing.</p>
        )}
      </div>

      <div className={`mt-3 grid gap-3 ${compact ? "" : "sm:grid-cols-2"}`}>
        <section>
          <h3 className="text-sm font-semibold">Active problems</h3>
          <List items={p.activeProblems} empty="None recorded" />
        </section>
        <section>
          <h3 className="text-sm font-semibold">Medications</h3>
          <List items={p.medications} empty="None recorded" />
        </section>
      </div>
    </section>
  );
}
