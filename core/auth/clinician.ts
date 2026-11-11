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
}
