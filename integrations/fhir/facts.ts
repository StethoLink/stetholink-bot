import type { ClinicalFact, ClinicalFactCategory, KnownClinicalFact, MissingInformation } from "../../shared/contracts/index.ts";

/** The parts of FHIR R4 (and the R5 shapes that differ) this connector reads. Nothing else is interpreted. */
export interface Coding { system?: string; code?: string; display?: string }
export interface Concept { text?: string; coding?: Coding[] }
export interface Reference { reference?: string; display?: string }
export interface Quantity { value?: number; unit?: string; code?: string }
interface Period { start?: string; end?: string }
interface ObservationValue {
  code?: Concept;
  valueQuantity?: Quantity;
  valueString?: string;
  valueCodeableConcept?: Concept;
  valueBoolean?: boolean;
  valueInteger?: number;
  valueDateTime?: string;
  interpretation?: Concept[];
  referenceRange?: Array<{ low?: Quantity; high?: Quantity; text?: string }>;
}
export interface FhirResource extends ObservationValue {
  resourceType?: string;
  id?: string;
  meta?: { lastUpdated?: string };
  name?: Array<{ text?: string; given?: string[]; family?: string }>;
  gender?: string;
  birthDate?: string;
  subject?: Reference;
  patient?: Reference;
  class?: Coding | Concept[];
  status?: string;
  period?: Period;
  actualPeriod?: Period;
  plannedStartDate?: string;
  reasonCode?: Concept[];
  reasonReference?: Reference[];
  reason?: Array<{ value?: Array<{ concept?: Concept; reference?: Reference }> }>;
  entry?: Array<{ resource?: FhirResource }>;
  link?: Array<{ relation?: string; url?: string }>;
  clinicalStatus?: Concept;
  verificationStatus?: Concept;
  recordedDate?: string;
  onsetDateTime?: string;
  onsetPeriod?: Period;
  criticality?: string;
  reaction?: Array<{ substance?: Concept; manifestation?: Array<Concept & { concept?: Concept }>; severity?: string }>;
  medicationCodeableConcept?: Concept;
  medicationReference?: Reference;
  medication?: { concept?: Concept; reference?: Reference };
  contained?: FhirResource[];
  authoredOn?: string;
  dosageInstruction?: Array<{
    text?: string;
    route?: Concept;
    timing?: { code?: Concept };
    doseAndRate?: Array<{ doseQuantity?: Quantity }>;
  }>;
  effectiveDateTime?: string;
  effectivePeriod?: Period;
  effectiveInstant?: string;
  issued?: string;
  component?: ObservationValue[];
}

interface Loaded { resources: FhirResource[]; included: FhirResource[]; truncated: boolean; failed: boolean }

export interface ChartInput {
  allergies: Loaded;
  conditions: Loaded;
  medications: Loaded;
  vitals: Loaded;
  laboratory: Loaded;
}

export interface NormalizeOptions {
  factId(prefix: string, reference: string): string;
  now: Date;
  windows: { vitalDays: number; laboratoryDays: number };
}

/** Core accepts at most 64 facts and 24 KB of context. These stay below both, leaving room for encounter facts. */
export const FACT_BUDGET = 60;
export const FACT_BYTE_BUDGET = 19_000;
// How many facts each category takes before the others have had their share. Highest priority first.
const SHARE: Array<[ClinicalFactCategory, number]> = [["allergy", 12], ["problem", 14], ["medication", 14], ["vital_sign", 8], ["investigation", 12]];
const CATEGORY_NAME: Partial<Record<ClinicalFactCategory, string>> = {
  allergy: "allergies", problem: "active problems", medication: "active medication orders", vital_sign: "vital signs", investigation: "laboratory results",
};
// SNOMED CT assertions of absence. They are documented statements, kept in the record's own words.
const NO_KNOWN_ALLERGY = new Set(["716186003", "409137002", "429625007", "428607008", "160244002"]);

/** Chart text is data: brackets, markup and control characters never reach a statement or a citation. */
function clean(value: unknown, max: number): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, " ").replace(/[\[{<]/g, "(").replace(/[\]}>]/g, ")").replace(/\\/g, "/")
    .replace(/\s+/g, " ").trim().slice(0, max).trim();
}
const conceptText = (concept: Concept | undefined, max = 160) =>
  clean(concept?.text || concept?.coding?.find((coding) => coding.display)?.display || concept?.coding?.[0]?.code, max);
const code = (concept: Concept | undefined) => concept?.coding?.find((coding) => coding.code)?.code?.toLowerCase() ?? clean(concept?.text, 40).toLowerCase();
const quantity = (value: Quantity | undefined) =>
  typeof value?.value === "number" && Number.isFinite(value.value) ? `${value.value}${clean(value.unit || value.code, 40) ? ` ${clean(value.unit || value.code, 40)}` : ""}` : "";

function isoTime(...candidates: Array<string | undefined>) {
  for (const candidate of candidates) {
    const time = candidate ? Date.parse(candidate) : NaN;
    if (Number.isFinite(time)) return new Date(time).toISOString();
  }
  return undefined;
}

interface Candidate { fact: ClinicalFact; time: number }

/**
 * Turns the loaded FHIR resources into normalized facts. Every fact keeps the reference of the
 * record it came from and the time it was documented. Nothing is inferred: a missing dose is
 * reported as not recorded, an empty allergy list as not recorded (never as "no allergies"),
 * and whatever is left out for size or could not be loaded is listed in `notes` for the physician.
 */
export function normalizeChart(input: ChartInput, options: NormalizeOptions): { facts: ClinicalFact[]; notes: string[] } {
  const notes: string[] = [];
  const loadedAt = new Date(Date.UTC(options.now.getUTCFullYear(), options.now.getUTCMonth(), options.now.getUTCDate())).toISOString();
  let undated = 0;
  const byCategory = new Map<ClinicalFactCategory, Candidate[]>(SHARE.map(([category]) => [category, []]));

  function known(category: ClinicalFactCategory, prefix: string, resource: FhirResource, label: string, value: KnownClinicalFact["value"], unit: string | undefined, documented: string | undefined) {
    const reference = `${resource.resourceType}/${resource.id}`;
    if (!documented) undated++;
    const timestamp = documented ?? loadedAt;
    byCategory.get(category)!.push({
      time: Date.parse(timestamp),
      fact: { id: options.factId(prefix, reference), category, label, status: "known", value, ...(unit ? { unit } : {}), source: { type: "fhir", reference }, timestamp },
    });
  }
  function missing(category: ClinicalFactCategory, prefix: string, key: string, label: string, reason: MissingInformation["reason"]) {
    byCategory.get(category)!.push({
      time: Date.parse(loadedAt),
      fact: { id: options.factId(prefix, key), category, label, status: "unknown", reason, source: { type: "fhir", reference: key }, timestamp: loadedAt },
    });
  }
  /** A search the EHR refused is an explicit unknown, never an empty list. */
  function unavailable(category: ClinicalFactCategory, prefix: string, resourceType: string, title: string) {
    missing(category, prefix, `${resourceType}/not-loaded`, `${title} (could not be loaded from the EHR)`, "not_provided");
    notes.push(`${title} could not be loaded from the EHR. Check them in the chart.`);
  }
  function truncated(loaded: Loaded, title: string) {
    if (loaded.truncated) notes.push(`The EHR holds more ${title} than StethoLink loads at once; the first ${loaded.resources.length} records were read. Check the chart for the rest.`);
  }

  // Allergies and intolerances.
  if (input.allergies.failed) unavailable("allergy", "allergy", "AllergyIntolerance", "Allergies");
  else {
    truncated(input.allergies, "allergy records");
    let listed = 0;
    for (const resource of input.allergies.resources) {
      if (["inactive", "resolved"].includes(code(resource.clinicalStatus)) || ["refuted", "entered-in-error"].includes(code(resource.verificationStatus))) continue;
      const label = conceptText(resource.code) || conceptText(resource.reaction?.find((reaction) => reaction.substance)?.substance);
      if (!label) continue;
      listed++;
      const absence = resource.code?.coding?.some((coding) => coding.code && NO_KNOWN_ALLERGY.has(coding.code));
      const reactions = (resource.reaction ?? []).flatMap((reaction) => {
        const shown = (reaction.manifestation ?? []).map((item) => conceptText(item.concept ?? item, 80)).filter(Boolean).join(", ");
        const severity = clean(reaction.severity, 20);
        return shown ? [`${shown}${severity ? ` (${severity})` : ""}`] : severity ? [`severity ${severity}`] : [];
      });
      const details = absence ? [] : [
        ...(reactions.length ? [`Reaction: ${reactions.join("; ")}`] : []),
        ...(clean(resource.criticality, 30) ? [`criticality: ${clean(resource.criticality, 30)}`] : []),
        ...(["unconfirmed", "presumed"].includes(code(resource.verificationStatus)) ? [`recorded as ${code(resource.verificationStatus)}`] : []),
      ];
      known("allergy", "allergy", resource, label, details.length ? clean(details.join("; "), 300) : true, undefined, isoTime(resource.recordedDate, resource.onsetDateTime, resource.meta?.lastUpdated));
    }
    // No record is not "no allergies": it is an explicit unknown.
    if (!listed) missing("allergy", "allergy", "AllergyIntolerance/none-recorded", "Allergies", "not_recorded");
  }

  // Active problems.
  if (input.conditions.failed) unavailable("problem", "problem", "Condition", "Active problems");
  else {
    truncated(input.conditions, "problem records");
    const seen = new Set<string>();
    const active = input.conditions.resources
      .filter((resource) => ["active", "recurrence", "relapse"].includes(code(resource.clinicalStatus)) && !["refuted", "entered-in-error"].includes(code(resource.verificationStatus)))
      .map((resource) => ({ resource, label: conceptText(resource.code), documented: isoTime(resource.recordedDate, resource.onsetDateTime, resource.onsetPeriod?.start, resource.meta?.lastUpdated) }))
      .filter((entry) => entry.label)
      .sort((a, b) => (b.documented ?? "").localeCompare(a.documented ?? "") || String(a.resource.id).localeCompare(String(b.resource.id)));
    for (const { resource, label, documented } of active) {
      // The same problem recorded twice is listed once, from its most recent record.
      if (seen.has(label.toLowerCase())) continue;
      seen.add(label.toLowerCase());
      const verification = code(resource.verificationStatus);
      known("problem", "problem", resource, label, ["provisional", "differential", "unconfirmed"].includes(verification) ? `Recorded as ${verification}` : true, undefined, documented);
    }
    if (!active.length) missing("problem", "problem", "Condition/none-recorded", "Active problems", "not_recorded");
  }

  // Active medication orders.
  if (input.medications.failed) unavailable("medication", "medication", "MedicationRequest", "Active medication orders");
  else {
    truncated(input.medications, "medication orders");
    let unnamed = 0;
    let listed = 0;
    for (const resource of input.medications.resources) {
      if (resource.status !== "active") continue;
      const reference = resource.medicationReference ?? resource.medication?.reference;
      const target = reference?.reference;
      const referenced = target?.startsWith("#")
        ? resource.contained?.find((item) => item.id === target.slice(1))
        : input.medications.included.find((item) => item.resourceType === "Medication" && (target === `Medication/${item.id}` || target?.endsWith(`/Medication/${item.id}`)));
      const label = conceptText(resource.medicationCodeableConcept ?? resource.medication?.concept) || clean(reference?.display, 160) || conceptText(referenced?.code);
      if (!label) { unnamed++; continue; }
      listed++;
      const doses = (resource.dosageInstruction ?? []).map((dosage) => clean(dosage.text, 200) ||
        [quantity(dosage.doseAndRate?.find((dose) => dose.doseQuantity)?.doseQuantity), conceptText(dosage.route, 40), conceptText(dosage.timing?.code, 60)].filter(Boolean).join(" ")).filter(Boolean);
      // A dose is restated only when the order records one. It is never completed or guessed.
      known("medication", "medication", resource, label, doses.length ? clean(doses.join("; "), 300) : "Dose not recorded in the order", undefined, isoTime(resource.authoredOn, resource.meta?.lastUpdated));
    }
    if (unnamed) notes.push(`${unnamed} active medication order${unnamed === 1 ? " has" : "s have"} no readable medication name and ${unnamed === 1 ? "is" : "are"} not listed. Check the medication list in the chart.`);
    if (!listed && !unnamed) missing("medication", "medication", "MedicationRequest/none-recorded", "Active medication orders", "not_recorded");
  }

  // Observations: the latest final value of each test or measurement inside its window.
  function observations(loaded: Loaded, category: ClinicalFactCategory, prefix: string, title: string, days: number) {
    if (loaded.failed) { unavailable(category, prefix, `Observation/${prefix}`, title); return; }
    truncated(loaded, title.toLowerCase());
    const latest = new Map<string, { resource: FhirResource; label: string; documented: string | undefined }>();
    let unreadable = 0;
    for (const resource of loaded.resources) {
      if (!["final", "amended", "corrected"].includes(resource.status ?? "")) continue;
      const label = conceptText(resource.code);
      if (!label) { unreadable++; continue; }
      const documented = isoTime(resource.effectiveDateTime, resource.effectivePeriod?.end, resource.effectivePeriod?.start, resource.effectiveInstant, resource.issued, resource.meta?.lastUpdated);
      // The window is applied here as well: not every EHR honours the date search parameter.
      if (documented && Date.parse(documented) < options.now.getTime() - (days + 1) * 86_400_000) continue;
      const coding = resource.code?.coding?.find((entry) => entry.code);
      const key = coding ? `${coding.system ?? ""}|${coding.code}` : label.toLowerCase();
      const previous = latest.get(key);
      if (!previous || (documented ?? "") > (previous.documented ?? "") || ((documented ?? "") === (previous.documented ?? "") && String(resource.id) < String(previous.resource.id))) {
        latest.set(key, { resource, label, documented });
      }
    }
    for (const { resource, label, documented } of latest.values()) {
      const result = observationValue(resource);
      if (!result) { unreadable++; continue; }
      known(category, prefix, resource, label, result.value, result.unit, documented);
    }
    if (unreadable) notes.push(`${unreadable} ${title.toLowerCase()} record${unreadable === 1 ? " has" : "s have"} no readable name or value and ${unreadable === 1 ? "is" : "are"} not listed.`);
    if (!latest.size) missing(category, prefix, `Observation/${prefix}-none-recorded`, `${title} in the last ${days} days`, "not_recorded");
  }
  observations(input.vitals, "vital_sign", "vital", "Vital signs", options.windows.vitalDays);
  observations(input.laboratory, "investigation", "lab", "Laboratory results", options.windows.laboratoryDays);
  notes.push(`Loaded from the EHR: the latest value of each laboratory test from the last ${options.windows.laboratoryDays} days and of each vital sign from the last ${options.windows.vitalDays} days. Older results are not included.`);

  // Deterministic selection under the Core limits: newest first inside a category, categories in priority order.
  for (const candidates of byCategory.values()) candidates.sort((a, b) => b.time - a.time || a.fact.id.localeCompare(b.fact.id));
  const take = new Map<ClinicalFactCategory, number>();
  let free = FACT_BUDGET;
  for (const [category, share] of SHARE) {
    const count = Math.min(share, byCategory.get(category)!.length, free);
    take.set(category, count);
    free -= count;
  }
  for (const [category] of SHARE) {
    const extra = Math.min(free, byCategory.get(category)!.length - take.get(category)!);
    take.set(category, take.get(category)! + extra);
    free -= extra;
  }
  const selected = () => SHARE.flatMap(([category]) => byCategory.get(category)!.slice(0, take.get(category)!).map((candidate) => candidate.fact));
  const bytes = () => new TextEncoder().encode(JSON.stringify(selected())).length;
  // Over the size limit, the oldest items of the lowest-priority category go first.
  for (const [category] of [...SHARE].reverse()) {
    while (bytes() > FACT_BYTE_BUDGET && take.get(category)! > 1) take.set(category, take.get(category)! - 1);
  }
  for (const [category] of SHARE) {
    const omitted = byCategory.get(category)!.length - take.get(category)!;
    if (omitted > 0) notes.push(`Only the ${take.get(category)} most recent ${CATEGORY_NAME[category]} are included here; ${omitted} more ${omitted === 1 ? "is" : "are"} in the chart.`);
  }
  if (undated) notes.push(`${undated} chart item${undated === 1 ? " has" : "s have"} no recorded date in the EHR; the date shown for ${undated === 1 ? "it" : "them"} is the day the chart was loaded.`);
  return { facts: selected(), notes };
}

function extras(value: ObservationValue) {
  const interpretation = (value.interpretation ?? []).map((concept) => conceptText(concept, 40)).filter(Boolean).join(", ");
  const range = value.referenceRange?.[0];
  const low = quantity(range?.low);
  const high = quantity(range?.high);
  const rangeText = clean(range?.text, 80) || (low && high ? `${low} to ${high}` : low ? `at least ${low}` : high ? `up to ${high}` : "");
  // Copied as recorded. Whether a value is abnormal is the EHR's statement, not StethoLink's.
  return [interpretation && `interpretation recorded: ${interpretation}`, rangeText && `reference range: ${rangeText}`].filter(Boolean).join("; ");
}

function plainValue(value: ObservationValue): string {
  return quantity(value.valueQuantity) || clean(value.valueString, 200) || conceptText(value.valueCodeableConcept, 120) ||
    (typeof value.valueBoolean === "boolean" ? (value.valueBoolean ? "Yes" : "No") : "") ||
    (typeof value.valueInteger === "number" ? String(value.valueInteger) : "") || clean(value.valueDateTime, 40);
}

/** One observation as a value the physician can check against its record: quantity, text, coded value or components. */
function observationValue(resource: FhirResource): { value: string | number; unit?: string } | undefined {
  const own = plainValue(resource);
  const components = (resource.component ?? []).map((component) => {
    const name = conceptText(component.code, 80);
    const value = plainValue(component);
    const extra = extras(component);
    return name && value ? `${name} ${value}${extra ? ` (${extra})` : ""}` : "";
  }).filter(Boolean);
  const extra = extras(resource);
  if (!own && !components.length) return undefined;
  if (own && !components.length && !extra) {
    const amount = resource.valueQuantity;
    if (typeof amount?.value === "number" && Number.isFinite(amount.value)) {
      const unit = clean(amount.unit || amount.code, 40);
      return { value: amount.value, ...(unit ? { unit } : {}) };
    }
    return { value: own };
  }
  return { value: clean([own, ...components].filter(Boolean).join("; ") + (extra ? ` (${extra})` : ""), 400) };
}
