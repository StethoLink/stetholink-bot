import type { ClinicianContext } from "@/core/auth/clinician";

export interface VerifiedLaunch {
  context: ClinicianContext;
  source: "smart";
  ehrAccessToken?: string;
  /** "Practitioner/<id>" from the verified fhirUser claim: the author of anything written to the chart. */
  ehrUser?: string;
}

export interface IdentityAdapter<Launch> {
  verify(launch: Launch): Promise<VerifiedLaunch>;
}
