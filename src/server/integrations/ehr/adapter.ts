/** Hospital EHR adapter (launch context, embedding, write-back). One implementation per vendor. */
export interface EhrLaunchContext {
  patientId: string;
  encounterId?: string;
  practitionerId: string;
}

export interface EhrAdapter {
  readonly vendor: string;
  resolveLaunchContext(launchToken: string): Promise<EhrLaunchContext>;
}
