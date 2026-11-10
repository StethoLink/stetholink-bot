import { createFhirConnector, type FhirLaunchGrant } from "../fhir/connector.ts";

export function createOpenEmrConnector(grant: FhirLaunchGrant, request: typeof fetch = fetch) {
  // OpenEMR deployments register their site-specific FHIR base URL during onboarding.
  return createFhirConnector(grant, request);
}
