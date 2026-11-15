import { readFileSync } from "node:fs";

/** Loads the fictional FHIR-shaped evaluation charts and answers FHIR reads and searches for one of them. */
export interface EvaluationCase {
  id: string; title: string; request: string;
  patient: Record<string, unknown>; encounter: Record<string, unknown>; resources: Array<Record<string, unknown> & { resourceType: string }>;
  expected: { outcome: "draft" | "clarification" | "draft_or_clarification"; specialty?: string; mustMention?: string[]; mustNotMention?: string[]; concernKinds?: string[]; missingInformation?: string[]; notes?: string[]; properties: string[] };
}
export const evaluationCases = (JSON.parse(readFileSync(new URL("../../core/agent/evaluations/consultation/cases.json", import.meta.url), "utf8")) as { cases: EvaluationCase[] }).cases;

const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000 - 3_600_000).toISOString();
function dated(resource: Record<string, unknown>, now: Date) {
  const { recordedDaysAgo, authoredDaysAgo, effectiveDaysAgo, ...rest } = resource as Record<string, unknown> & { recordedDaysAgo?: number; authoredDaysAgo?: number; effectiveDaysAgo?: number };
  return { ...rest, ...(recordedDaysAgo !== undefined ? { recordedDate: daysAgo(now, recordedDaysAgo) } : {}), ...(authoredDaysAgo !== undefined ? { authoredOn: daysAgo(now, authoredDaysAgo) } : {}),
    ...(effectiveDaysAgo !== undefined ? { effectiveDateTime: daysAgo(now, effectiveDaysAgo) } : {}) };
}
/** A `fetch` for the FHIR base that serves this case's chart. */
export function evaluationFhir(evaluation: EvaluationCase, base: string, now = new Date()): typeof fetch {
  const months = /^__MONTHS_AGO_(\d+)__$/.exec(String(evaluation.patient.birthDate));
  const patient = { ...evaluation.patient, ...(months ? { birthDate: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - Number(months[1]), 1)).toISOString().slice(0, 10) } : {}) };
  const encounter = { ...evaluation.encounter, period: { start: daysAgo(now, 0) } };
  const resources = evaluation.resources.map((resource) => dated(resource, now) as Record<string, unknown> & { resourceType: string });
  return (async (target: URL | string | Request) => {
    const url = new URL(String(target));
    const path = url.href.slice(base.length).split("?")[0];
    if (path === "/Patient/fic-pt-1") return Response.json(patient);
    if (path === "/Encounter/fic-enc-1") return Response.json(encounter);
    const type = path.slice(1);
    const category = url.searchParams.get("category");
    const entry = resources.filter((resource) => resource.resourceType === type &&
      (!category || JSON.stringify((resource as { category?: unknown }).category ?? "").includes(`"${category}"`))).map((resource) => ({ resource }));
    return Response.json({ resourceType: "Bundle", entry });
  }) as typeof fetch;
}
