/** Opaque clinical provider/recipient identifier, not an AI model provider name. */
export type ProviderId = string;

/** Projected from a verified server session. Parsing this shape does not authenticate it. */
export interface ClinicianIdentity {
  clinicianId: string;
  roles: ReadonlyArray<"clinician" | "admin">;
  providerId?: ProviderId;
}
