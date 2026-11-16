import type { DataClassification } from "@/shared/contracts";
import { classificationOfSource, encounterContextSchema, patientContextSchema } from "@/shared/schemas";
import type { ClinicalDataAdapter } from "@/core/tools/connector";
import { RouteError } from "@/core/errors";
import { groundContext } from "./grounding";
import { patientDemographics } from "./demographics";

/** Reads and validates the chart for one request. Nothing outside the verified chart is loaded. */
export async function loadVerifiedChart(adapter: ClinicalDataAdapter, classification: DataClassification, input: { patientId: string; encounterId?: string }) {
  const MISMATCH = "Clinical data does not belong to this session's data classification";
  if (classificationOfSource(adapter.source) !== classification) throw new RouteError("forbidden", MISMATCH);
  const rawPatient = await adapter.getPatient(input.patientId);
  if (!rawPatient) throw new RouteError("not_found", "Patient not found");
  const patientResult = patientContextSchema.safeParse(rawPatient);
  if (!patientResult.success) throw new RouteError("safety_blocked", "Invalid clinical patient context");
  const patient = patientResult.data;
  if (classificationOfSource(patient.source) !== classification) throw new RouteError("forbidden", MISMATCH);
  if (patient.patientId !== input.patientId) throw new RouteError("safety_blocked", "Patient context mismatch");
  const rawEncounter = input.encounterId ? await adapter.getEncounter(input.encounterId) : null;
  const encounterResult = rawEncounter ? encounterContextSchema.safeParse(rawEncounter) : null;
  if (encounterResult && !encounterResult.success) throw new RouteError("safety_blocked", "Invalid clinical encounter context");
  const encounter = encounterResult?.success ? encounterResult.data : null;
  if (input.encounterId && (!encounter || encounter.patientId !== patient.patientId || encounter.encounterId !== input.encounterId)) {
    throw new RouteError("invalid_request", "Encounter does not belong to this patient");
  }
  // What the connector left out or could not load is carried into the draft for the physician.
  return { patient, encounter, demographics: patientDemographics(patient), grounded: groundContext(patient, encounter, classification), chartNotes: patient.chartNotes ?? [] };
}
