import type { ChartResourceType, ChartWriteItem, ClinicalWriteAdapter } from "../../core/tools/chart-writer.ts";
import { isFhirId, type FhirLaunchGrant } from "./connector.ts";

export interface FhirWriteGrant extends FhirLaunchGrant {
  encounterId: string;
  /** "Practitioner/<id>" of the signed-in clinician, from the verified fhirUser. */
  practitionerReference?: string;
  /** Scopes the EHR granted at launch. A resource without a create scope is never attempted. */
  grantedScopes: readonly string[];
}
export interface FhirWriterOptions {
  /** Identifier system under which StethoLink's keys are stored in the EHR. */
  identifierSystem?: string;
  /** docStatus of a written note. "preliminary" lets the physician sign it inside the EHR. */
  docStatus?: "preliminary" | "final";
  /** LOINC code of the note type, set by the hospital. */
  noteTypeCode?: string;
  /**
   * Status of a written ServiceRequest or MedicationRequest. "draft" (the default) leaves the order in the EHR for the physician to sign and
   * release there, so nothing is dispensed or collected because of the write; "active" places it.
   */
  orderStatus?: "draft" | "active";
  now?: () => Date;
}

const RESOURCE: Record<ChartWriteItem["kind"], ChartResourceType> = {
  document: "DocumentReference", allergy: "AllergyIntolerance", condition: "Condition", medication: "MedicationStatement",
  service_request: "ServiceRequest", medication_request: "MedicationRequest",
};
const DOCUMENT_TYPE = {
  soap_note: { code: "11506-3", display: "Progress note" },
  consultation_request: { code: "57133-1", display: "Referral note" },
  specialist_report: { code: "11488-4", display: "Consult note" },
};
const codeSystem = (name: string, code: string) => ({ coding: [{ system: `http://terminology.hl7.org/CodeSystem/${name}`, code }] });

/** SMART v2 (`patient/Type.c`, `.cruds`) or v1 (`patient/Type.write`, `.*`), for the patient or the user. */
export function grantsCreate(scopes: readonly string[], resourceType: string) {
  return scopes.some((scope) => {
    const match = /^(?:patient|user)\/([A-Za-z*]+)\.([a-z*]+)(?:\?.*)?$/.exec(scope);
    if (!match || (match[1] !== resourceType && match[1] !== "*")) return false;
    return match[2] === "write" || match[2] === "*" || (/^[cruds]+$/.test(match[2]) && match[2].includes("c"));
  });
}

/**
 * FHIR R4 writer. One operation: conditional create (`POST` with `If-None-Exist` on StethoLink's
 * own identifier). It issues no PUT, PATCH or DELETE, and writes only for the launched patient
 * and encounter with the clinician's own EHR token.
 */
export function createFhirWriter(grant: FhirWriteGrant, request: typeof fetch = fetch, options: FhirWriterOptions = {}): ClinicalWriteAdapter {
  const base = new URL(grant.baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error("FHIR base URL must be a trusted HTTPS endpoint");
  if (!grant.accessToken || !isFhirId(grant.patientId) || !isFhirId(grant.encounterId)) throw new Error("Invalid FHIR write grant");
  const root = base.href.replace(/\/$/, "");
  const system = options.identifierSystem ?? "urn:stetholink:chart-write";
  const now = options.now ?? (() => new Date());
  const patient = { reference: `Patient/${grant.patientId}` };
  const encounter = { reference: `Encounter/${grant.encounterId}` };
  const practitioner = grant.practitionerReference && /^Practitioner(?:Role)?\/[A-Za-z0-9.-]{1,64}$/.test(grant.practitionerReference) ? { reference: grant.practitionerReference } : undefined;
  let supported: Promise<Set<string> | null> | undefined;

  /** Resource types for which the server's CapabilityStatement declares `create`. Null when it cannot be read. */
  function capabilities() {
    return supported ??= (async () => {
      try {
        const response = await request(`${root}/metadata`, { headers: { Accept: "application/fhir+json", Authorization: `Bearer ${grant.accessToken}` }, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000) });
        if (!response.ok) return null;
        const statement = await response.json() as { rest?: Array<{ resource?: Array<{ type?: string; interaction?: Array<{ code?: string }> }> }> };
        return new Set((statement.rest ?? []).flatMap((rest) => rest.resource ?? []).filter((resource) => resource.interaction?.some((interaction) => interaction.code === "create")).map((resource) => resource.type ?? ""));
      } catch { return null; }
    })();
  }

  function body(item: ChartWriteItem) {
    const identifier = [{ system, value: item.itemKey }];
    const stamp = now().toISOString();
    if (item.kind === "document") {
      const type = item.documentType === "soap_note" && options.noteTypeCode ? { code: options.noteTypeCode, display: "Clinical note" } : DOCUMENT_TYPE[item.documentType];
      return {
        resourceType: "DocumentReference", identifier, status: "current", docStatus: options.docStatus ?? "preliminary",
        type: { coding: [{ system: "http://loinc.org", ...type }], text: item.title },
        category: [{ coding: [{ system: "http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category", code: "clinical-note", display: "Clinical Note" }] }],
        subject: patient, date: stamp, ...(practitioner ? { author: [practitioner] } : {}), description: item.title,
        content: [{ attachment: { contentType: "text/plain; charset=utf-8", language: item.language, title: item.title, data: Buffer.from(item.text, "utf8").toString("base64") } }],
        context: { encounter: [encounter] },
      };
    }
    if (item.kind === "allergy") {
      return {
        resourceType: "AllergyIntolerance", identifier, clinicalStatus: codeSystem("allergyintolerance-clinical", "active"),
        // Reported in the visit: unconfirmed unless the physician confirmed this item.
        verificationStatus: codeSystem("allergyintolerance-verification", item.confirmedByPhysician ? "confirmed" : "unconfirmed"),
        type: item.intolerance ? "intolerance" : "allergy", code: { text: item.substance }, patient, encounter, recordedDate: stamp,
        ...(practitioner ? { recorder: practitioner } : {}),
        ...(item.reaction ? { reaction: [{ manifestation: [{ text: item.reaction }] }] } : {}),
        note: [{ text: "Reported by the patient during the visit and recorded by the treating physician through StethoLink." }],
      };
    }
    if (item.kind === "condition") {
      return {
        resourceType: "Condition", identifier, clinicalStatus: codeSystem("condition-clinical", "active"), verificationStatus: codeSystem("condition-ver-status", "unconfirmed"),
        category: [codeSystem("condition-category", "problem-list-item")], code: { text: item.name }, subject: patient, encounter, recordedDate: stamp,
        ...(practitioner ? { recorder: practitioner } : {}),
        note: [{ text: `${item.detail ? `${item.detail}. ` : ""}Stated during the visit and recorded by the treating physician through StethoLink.` }],
      };
    }
    if (item.kind === "service_request" || item.kind === "medication_request") {
      // An order the physician approved from the hospital's catalog. The code and the dose are the catalog's own, as text and as the catalog's code.
      const status = options.orderStatus ?? "draft";
      const coding = item.code ? { coding: [{ system: item.code.system, code: item.code.code, ...(item.code.display ? { display: item.code.display } : {}) }] } : {};
      const common = {
        identifier, status, intent: "order", subject: patient, encounter, authoredOn: stamp, ...(practitioner ? { requester: practitioner } : {}),
        ...(item.physicianNote ? { note: [{ text: item.physicianNote }] } : {}),
      };
      if (item.kind === "service_request") return { resourceType: "ServiceRequest", ...common, category: [{ text: item.orderKind }], code: { ...coding, text: item.display } };
      const { product, dose, route, frequency, duration } = item.medication;
      return {
        resourceType: "MedicationRequest", ...common, medicationCodeableConcept: { ...coding, text: product },
        dosageInstruction: [{ text: [dose, route, frequency, duration].filter(Boolean).join(", ") }],
      };
    }
    return {
      resourceType: "MedicationStatement", identifier, status: "active", medicationCodeableConcept: { text: item.name }, subject: patient, context: encounter,
      dateAsserted: stamp, informationSource: patient, ...(item.dosageText ? { dosage: [{ text: item.dosageText }] } : {}),
      note: [{ text: "Medicine the patient reports taking. Recorded by the treating physician through StethoLink." }],
    };
  }

  return {
    source: "fhir",
    async create(item) {
      const resourceType = RESOURCE[item.kind];
      if (!/^[A-Za-z0-9.-]{8,64}$/.test(item.itemKey)) return { status: "failed", resourceType, failure: "The item has no valid key" };
      if (!grantsCreate(grant.grantedScopes, resourceType)) return { status: "unsupported", resourceType, failure: `The EHR did not give StethoLink permission to create ${resourceType}` };
      const declared = await capabilities();
      if (declared && !declared.has(resourceType)) return { status: "unsupported", resourceType, failure: `The EHR does not accept new ${resourceType} records from applications` };
      let response: Response;
      try {
        response = await request(`${root}/${resourceType}`, {
          method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000), body: JSON.stringify(body(item)),
          headers: {
            Authorization: `Bearer ${grant.accessToken}`, Accept: "application/fhir+json", "Content-Type": "application/fhir+json", Prefer: "return=representation",
            // Conditional create: the server creates only when no resource carries this identifier.
            "If-None-Exist": `identifier=${encodeURIComponent(`${system}|${item.itemKey}`)}`,
          },
        });
      } catch { return { status: "failed", resourceType, failure: "The EHR could not be reached. Nothing was written" }; }
      const created = response.status === 201;
      if (!created && response.status !== 200) {
        await response.body?.cancel();
        const failure = response.status === 401 || response.status === 403 ? "The EHR refused the write for this session"
          : response.status === 412 ? "The EHR already holds more than one record with this key" : `The EHR did not accept the record (status ${response.status})`;
        return { status: "failed", resourceType, failure };
      }
      const stored = await response.json().catch(() => null) as { id?: unknown } | null;
      const location = /\/([A-Za-z0-9.-]{1,64})(?:\/_history\/[^/]+)?$/.exec(response.headers.get("location") ?? "")?.[1];
      const resourceId = typeof stored?.id === "string" && isFhirId(stored.id) ? stored.id : location;
      if (!resourceId) return { status: "failed", resourceType, failure: "The EHR did not return the identifier of the record" };
      return { status: created ? "created" : "existing", resourceType, resourceId };
    },
  };
}
