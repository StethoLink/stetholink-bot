import { createHmac } from "node:crypto";
import { ChartUnavailableError, type ClinicalDataAdapter } from "../../core/tools/connector.ts";
import type { ClinicalFact, EncounterContext, PatientContext } from "../../shared/contracts/index.ts";
import { normalizeChart, type FhirResource } from "./facts.ts";

export const isFhirId = (value: string) => /^(?!\.{1,2}$)[A-Za-z0-9.-]{1,64}$/.test(value);

export interface FhirLaunchGrant {
  baseUrl: string;
  accessToken: string;
  patientId: string;
  encounterId?: string;
}

export interface FhirConnectorOptions {
  /**
   * Server-side key for fact ids. A fact id is a keyed digest of its EHR record reference, so it is
   * stable for the same record and reveals no chart identifier where the id travels without its source.
   */
  factIdKey?: string;
  now?: () => Date;
  /** Results per search page (`_count`). */
  pageSize?: number;
  /** Pages followed for one search before the remainder is reported as not loaded. */
  maxPages?: number;
  /** Records kept from one search. */
  maxRecords?: number;
}

function trustedBase(value: string) {
  const base = new URL(value);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error("FHIR base URL must be a trusted HTTPS endpoint");
  }
  return base;
}

const ENCOUNTER_CLASS: Record<string, EncounterContext["type"]> = {
  AMB: "outpatient", HH: "outpatient", FLD: "outpatient",
  IMP: "inpatient", ACUTE: "inpatient", NONAC: "inpatient", OBSENC: "inpatient", SS: "inpatient", PRENC: "inpatient",
  EMER: "emergency", VR: "virtual",
};
// R4 and R5 status codes.
const ENCOUNTER_STATUS: Record<string, EncounterContext["status"]> = {
  planned: "planned", arrived: "arrived", triaged: "triaged", "in-progress": "in_progress", onleave: "on_leave", "on-hold": "on_leave",
  finished: "finished", completed: "finished", discharged: "finished", cancelled: "cancelled", discontinued: "cancelled",
};

interface Loaded { resources: FhirResource[]; included: FhirResource[]; truncated: boolean; failed: boolean }

export function createFhirConnector(grant: FhirLaunchGrant, request: typeof fetch = fetch, options: FhirConnectorOptions = {}): ClinicalDataAdapter {
  const base = trustedBase(grant.baseUrl);
  if (!grant.accessToken || !isFhirId(grant.patientId) || (grant.encounterId && !isFhirId(grant.encounterId))) {
    throw new Error("Invalid FHIR launch grant");
  }
  const root = base.href.replace(/\/$/, "");
  const rootPath = base.pathname.replace(/\/$/, "");
  const pageSize = options.pageSize ?? 100;
  const maxPages = options.maxPages ?? 5;
  const maxRecords = options.maxRecords ?? 300;
  const now = options.now ?? (() => new Date());
  const patientRefs = new Set([`Patient/${grant.patientId}`, `${root}/Patient/${grant.patientId}`]);

  async function get(url: string): Promise<{ status: number; body: FhirResource | null }> {
    const res = await request(url, {
      headers: { Authorization: `Bearer ${grant.accessToken}`, Accept: "application/fhir+json" },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) { await res.body?.cancel(); return { status: res.status, body: null }; }
    return { status: res.status, body: await res.json() as FhirResource };
  }

  async function read(path: string): Promise<FhirResource | null> {
    const { status, body } = await get(`${root}/${path}`);
    if (status === 404) return null;
    if (!body) throw new Error(`FHIR request failed with status ${status}`);
    return body;
  }

  /**
   * The access token is sent only to the registered FHIR base: a `next` link must stay on the
   * same origin and under the same base path, or the remaining pages are not followed.
   */
  function nextPage(bundle: FhirResource): string | undefined {
    const link = bundle.link?.find((entry) => entry.relation === "next")?.url;
    if (!link) return undefined;
    let url: URL;
    try { url = new URL(link, root + "/"); } catch { return ""; }
    const inside = url.origin === base.origin && (url.pathname === rootPath || url.pathname.startsWith(rootPath + "/")) && !url.username && !url.password;
    return inside ? url.href : "";
  }

  /**
   * One patient-scoped search, following pages up to the caps. A search the EHR refuses or cannot
   * serve does not fail the chart: it is reported as not loaded, and the caller shows that.
   */
  async function search(resourceType: string, filters: Record<string, string>): Promise<Loaded> {
    const loaded: Loaded = { resources: [], included: [], truncated: false, failed: false };
    let url: string | undefined = `${root}/${resourceType}?${new URLSearchParams({ patient: grant.patientId, ...filters, _count: String(pageSize) })}`;
    for (let page = 0; url; page++) {
      if (page >= maxPages) { loaded.truncated = true; break; }
      let bundle: FhirResource | null;
      try { bundle = (await get(url)).body; } catch { bundle = null; }
      if (bundle?.resourceType !== "Bundle") { if (page === 0) loaded.failed = true; else loaded.truncated = true; break; }
      for (const { resource } of bundle.entry ?? []) {
        if (!resource?.id || !isFhirId(resource.id)) continue;
        if (resource.resourceType !== resourceType) { loaded.included.push(resource); continue; }
        const subject = (resource.patient ?? resource.subject)?.reference;
        if (!subject || !patientRefs.has(subject)) continue;
        if (loaded.resources.length >= maxRecords) { loaded.truncated = true; break; }
        loaded.resources.push(resource);
      }
      if (loaded.truncated) break;
      const next = nextPage(bundle);
      // A next link that leaves the FHIR base is never followed; what was loaded is kept.
      if (next === "") { loaded.truncated = true; break; }
      url = next;
    }
    return loaded;
  }

  const factId = (prefix: string, reference: string) =>
    `${prefix}-${createHmac("sha256", options.factIdKey ?? "stetholink-fact-id").update(`${root}|${reference}`).digest("hex").slice(0, 16)}`;

  function sinceDate(days: number) {
    return new Date(now().getTime() - days * 86_400_000).toISOString().slice(0, 10);
  }

  return {
    source: "fhir",
    async getPatient(id) {
      if (id !== grant.patientId) return null;
      const patient = await read(`Patient/${encodeURIComponent(id)}`);
      if (patient?.resourceType !== "Patient" || patient.id !== id) return null;
      const name = patient.name?.[0];
      const windows = { vitalDays: 14, laboratoryDays: 365 };
      const [allergies, conditions, medications, vitals, laboratory] = await Promise.all([
        search("AllergyIntolerance", {}),
        search("Condition", { "clinical-status": "active" }),
        search("MedicationRequest", { status: "active", _include: "MedicationRequest:medication" }),
        search("Observation", { category: "vital-signs", date: `ge${sinceDate(windows.vitalDays)}`, _sort: "-date" }),
        search("Observation", { category: "laboratory", date: `ge${sinceDate(windows.laboratoryDays)}`, _sort: "-date" }),
      ]);
      const chart = normalizeChart({ allergies, conditions, medications, vitals, laboratory }, { factId, now: now(), windows });
      const sex: PatientContext["sex"] = patient.gender === "male" || patient.gender === "female" || patient.gender === "other"
        ? patient.gender : "unknown";
      const known = (category: ClinicalFact["category"]) => chart.facts.filter((fact) => fact.category === category && fact.status === "known").map((fact) => fact.label);
      return {
        patientId: id,
        displayName: name?.text || [...(name?.given ?? []), name?.family].filter(Boolean).join(" ") || "Patient",
        birthDate: /^\d{4}-\d{2}-\d{2}$/.test(patient.birthDate ?? "") ? patient.birthDate : undefined,
        sex, allergies: chart.namedAllergies, activeProblems: known("problem"), medications: known("medication"), source: "fhir",
        clinicalFacts: chart.facts,
        ...(chart.notes.length ? { chartNotes: chart.notes } : {}),
      };
    },
    async getEncounter(id) {
      if (id !== grant.encounterId) return null;
      const encounter = await read(`Encounter/${encodeURIComponent(id)}`);
      if (encounter?.resourceType !== "Encounter" || encounter.id !== id) return null;
      if (!encounter.subject?.reference || !patientRefs.has(encounter.subject.reference)) return null;
      // R4: class is one Coding. R5: class is a list of CodeableConcepts.
      const classCodes = (Array.isArray(encounter.class)
        ? encounter.class.flatMap((concept) => concept.coding ?? [])
        : [encounter.class ?? {}]).map((coding) => (coding.code ?? "").toUpperCase()).filter(Boolean);
      const type = classCodes.map((code) => ENCOUNTER_CLASS[code]).find(Boolean);
      const status = ENCOUNTER_STATUS[encounter.status ?? ""];
      // The clinician is told why the visit cannot be opened; codes are EHR vocabulary, not patient data.
      if (!status) {
        throw new ChartUnavailableError("unsupported_encounter", `This visit cannot be opened because its status in the EHR is "${String(encounter.status ?? "missing").slice(0, 40)}". Open StethoLink from a planned, active or completed visit.`);
      }
      if (!type) {
        throw new ChartUnavailableError("unsupported_encounter", `This visit cannot be opened because its type in the EHR (${classCodes.length ? classCodes.join(", ").slice(0, 60) : "not recorded"}) is not one StethoLink supports yet. Ask your StethoLink administrator to add it.`);
      }
      // actualPeriod is R5. A planned or just-arrived visit may have no start yet.
      const start = (encounter.period ?? encounter.actualPeriod)?.start ?? encounter.plannedStartDate ?? encounter.meta?.lastUpdated;
      if (!start || !Number.isFinite(Date.parse(start))) {
        throw new ChartUnavailableError("unsupported_encounter", "This visit cannot be opened because the EHR records no start time for it.");
      }
      const reasons = [
        ...(encounter.reasonCode ?? []).map((concept) => concept.text || concept.coding?.find((coding) => coding.display)?.display),
        ...(encounter.reasonReference ?? []).map((reference) => reference.display),
        // R5: reason[].value[] is a CodeableReference.
        ...(encounter.reason ?? []).flatMap((reason) => (reason.value ?? []).map((value) => value.concept?.text || value.concept?.coding?.find((coding) => coding.display)?.display || value.reference?.display)),
      ].map((text) => text?.replace(/\s+/g, " ").trim()).filter((text): text is string => !!text);
      const reasonForVisit = [...new Set(reasons)].join("; ").slice(0, 400);
      return {
        encounterId: id, patientId: grant.patientId, type, status, startedAt: new Date(start).toISOString(),
        ...(reasonForVisit ? { reasonForVisit } : {}),
      };
    },
  };
}
