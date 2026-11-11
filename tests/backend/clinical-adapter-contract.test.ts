import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { ClinicalDataAdapter } from "@/shared/contracts";
import type { ClinicalDataAdapter as CoreClinicalDataAdapter } from "@/core/tools/connector";
import { createPatientContextService } from "@/core/patient-context/service";
import { syntheticClinicalAdapter } from "@/integrations/mock/connector";
import { ahmedPatient, syntheticEncounters, syntheticPatients } from "@/shared/mocks/synthetic-data";
import { encounterContextSchema, patientContextSchema } from "@/shared/schemas";

describe("normalized ClinicalDataAdapter contract", () => {
  it("implements the normalized read port and existing Core port", () => {
    expectTypeOf(syntheticClinicalAdapter).toMatchTypeOf<ClinicalDataAdapter>();
    expectTypeOf(syntheticClinicalAdapter).toMatchTypeOf<CoreClinicalDataAdapter>();
    expect(syntheticClinicalAdapter.source).toBe("synthetic");
  });

  it.each(syntheticPatients)("returns a normalized patient $patientId with provenance intact", async (fixture) => {
    const patient = await syntheticClinicalAdapter.getPatient(fixture.patientId);
    expect(patientContextSchema.parse(patient)).toEqual(fixture);
    expect(patient).not.toBe(fixture);
  });

  it.each(syntheticEncounters)("returns a normalized encounter $encounterId for a known patient", async (fixture) => {
    const encounter = await syntheticClinicalAdapter.getEncounter(fixture.encounterId);
    expect(encounterContextSchema.parse(encounter)).toEqual(fixture);
    expect(encounter).not.toBe(fixture);
    expect((await syntheticClinicalAdapter.getPatient(fixture.patientId))?.patientId).toBe(fixture.patientId);
  });

  it.each(["", "missing", "SYN-PT-AHMED", "syn-pt-ahmed/../syn-pt-001"])("returns null for unknown identifiers (%s)", async (id) => {
    expect(await syntheticClinicalAdapter.getPatient(id)).toBeNull();
    expect(await syntheticClinicalAdapter.getEncounter(id)).toBeNull();
  });

  it("isolates nested facts, provenance and arrays from caller mutations", async () => {
    const patient = (await syntheticClinicalAdapter.getPatient(ahmedPatient.patientId))!;
    patient.medications.push("Fictional mutation");
    patient.clinicalFacts![0].source.reference = "modified";
    patient.clinicalFacts!.splice(1);
    expect(await syntheticClinicalAdapter.getPatient(ahmedPatient.patientId)).toEqual(ahmedPatient);
    const encounter = (await syntheticClinicalAdapter.getEncounter("syn-enc-ahmed"))!;
    encounter.clinicalFacts![0].source.reference = "modified";
    expect((await syntheticClinicalAdapter.getEncounter("syn-enc-ahmed"))?.clinicalFacts?.[0].source.reference).toBe("synthetic-case-ahmed-v1");
  });

  it("passes source and unknown facts through the Core patient-context service", async () => {
    const service = createPatientContextService(syntheticClinicalAdapter);
    expect(await service.getContext(ahmedPatient.patientId)).toEqual(ahmedPatient);
    expect(await service.getContext("missing")).toBeNull();
  });

  it("propagates adapter failure instead of substituting a missing or fabricated patient", async () => {
    const error = new Error("Synthetic adapter unavailable");
    const adapter: CoreClinicalDataAdapter = { source: "synthetic", getPatient: vi.fn().mockRejectedValue(error), getEncounter: vi.fn().mockResolvedValue(null) };
    await expect(createPatientContextService(adapter).getContext("syn-pt-ahmed")).rejects.toBe(error);
  });
});
