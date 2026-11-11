import type { ClinicianContext } from "@/core/auth/clinician";

export interface VerifiedLaunch {
  context: ClinicianContext;
  source: "smart" | "synthetic";
  ehrAccessToken?: string;
}

export interface IdentityAdapter<Launch> {
  verify(launch: Launch): Promise<VerifiedLaunch>;
}
