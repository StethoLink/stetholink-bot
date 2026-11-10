import type { ClinicalDataAdapter } from "../../core/tools/connector.ts";
import type { EncounterContext, PatientContext } from "../../shared/contracts/index.ts";

export const isFhirId = (value: string) => /^(?!\.{1,2}$)[A-Za-z0-9.-]{1,64}$/.test(value);

interface FhirResource {
  resourceType?: string;
  id?: string;
  name?: Array<{ text?: string; given?: string[]; family?: string }>;
  gender?: string;
  birthDate?: string;
  subject?: { reference?: string };
  class?: { code?: string };
  status?: string;
  period?: { start?: string };
  entry?: Array<{ resource?: FhirResource }>;
  link?: Array<{ relation: string }>;
  code?: Concept;
  medicationCodeableConcept?: Concept;
  patient?: { reference?: string };
}

interface Concept {
  text?: string;
  coding?: Array<{ display?: string; code?: string }>;
}

export interface FhirLaunchGrant {
  baseUrl: string;
  accessToken: string;
  patientId: string;
  encounterId?: string;
}

const label = (concept?: Concept) => concept?.text || concept?.coding?.[0]?.display || concept?.coding?.[0]?.code;

export function createFhirConnector(grant: FhirLaunchGrant, request: typeof fetch = fetch): ClinicalDataAdapter {
  const base = new URL(grant.baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error("FHIR base URL must be a trusted HTTPS endpoint");
  }
  if (!grant.accessToken || !isFhirId(grant.patientId) || (grant.encounterId && !isFhirId(grant.encounterId))) {
    throw new Error("Invalid FHIR launch grant");
  }
  const root = base.href.replace(/\/$/, "");

  async function read(path: string): Promise<FhirResource | null> {
    const res = await request(`${root}/${path}`, {
      headers: { Authorization: `Bearer ${grant.accessToken}`, Accept: "application/fhir+json" },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`FHIR request failed with status ${res.status}`);
    return await res.json() as FhirResource;
  }

  async function clinicalLabels(
    resourceType: string,
    concept: (resource: FhirResource) => Concept | undefined,
    filters: Record<string, string> = {},
  ) {
    const query = new URLSearchParams({ patient: grant.patientId, ...filters });
    const bundle = await read(`${resourceType}?${query}`);
    if (bundle?.resourceType !== "Bundle" || bundle.link?.some((link) => link.relation === "next")) {
      throw new Error("FHIR search did not return a complete supported bundle");
    }
    return (bundle.entry ?? []).flatMap(({ resource }) => {
      if (!resource || resource.resourceType !== resourceType) return [];
      const patient = (resource.patient ?? resource.subject)?.reference;
      if (patient !== `Patient/${grant.patientId}` && patient !== `${root}/Patient/${grant.patientId}`) return [];
      const text = label(concept(resource));
      return text ? [text] : [];
    });
  }

  return {
    source: "fhir",
    async getPatient(id) {
      if (id !== grant.patientId) return null;
      const patient = await read(`Patient/${encodeURIComponent(id)}`);
      if (patient?.resourceType !== "Patient" || patient.id !== id) return null;
      const name = patient.name?.[0];
      const [allergies, activeProblems, medications] = await Promise.all([
        clinicalLabels("AllergyIntolerance", (resource) => resource.code),
        clinicalLabels("Condition", (resource) => resource.code, { "clinical-status": "active" }),
        clinicalLabels("MedicationRequest", (resource) => resource.medicationCodeableConcept, { status: "active" }),
      ]);
      const sex: PatientContext["sex"] = patient.gender === "male" || patient.gender === "female" || patient.gender === "other"
        ? patient.gender : "unknown";
      return {
        patientId: id,
        displayName: name?.text || [...(name?.given ?? []), name?.family].filter(Boolean).join(" ") || "Patient",
        birthDate: /^\d{4}-\d{2}-\d{2}$/.test(patient.birthDate ?? "") ? patient.birthDate : undefined,
        sex, allergies, activeProblems, medications, source: "fhir",
      };
    },
    async getEncounter(id) {
      if (id !== grant.encounterId) return null;
      const encounter = await read(`Encounter/${encodeURIComponent(id)}`);
      const patient = encounter?.subject?.reference;
      if (encounter?.resourceType !== "Encounter" || encounter.id !== id ||
          (patient !== `Patient/${grant.patientId}` && patient !== `${root}/Patient/${grant.patientId}`)) return null;
      const type: EncounterContext["type"] | undefined = ({
        AMB: "outpatient", IMP: "inpatient", EMER: "emergency", VR: "virtual",
      } as const)[encounter.class?.code as "AMB" | "IMP" | "EMER" | "VR"];
      const status: EncounterContext["status"] | undefined = ({
        planned: "planned", "in-progress": "in_progress", finished: "finished", cancelled: "cancelled",
      } as const)[encounter.status as "planned" | "in-progress" | "finished" | "cancelled"];
      const startedAt = encounter.period?.start;
      if (!type || !status || !startedAt || !Number.isFinite(Date.parse(startedAt))) return null;
      return { encounterId: id, patientId: grant.patientId, type, status, startedAt: new Date(startedAt).toISOString() };
    },
  };
}
