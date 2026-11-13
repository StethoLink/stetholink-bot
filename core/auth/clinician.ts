import type { DataClassification } from "@/shared/contracts";

export type ClinicianRole = "clinician" | "physician";

export interface ClinicianContext {
  clinicianId: string;
  tenantId: string;
  roles: readonly ClinicianRole[];
  scopes: readonly string[];
  patientId: string;
  encounterId?: string;
  expiresAt: number;
  authorization: "active";
  /**
   * Derived by the platform from the verified launch and the tenant configuration, never from
   * HTTP input. Everything this session reads, drafts, approves or routes carries the same value.
   */
  dataClassification: DataClassification;
}
