# Contract change: allergy status, vitals and labs in PatientContext

- **From → To:** claude → codex, integration
- **Type:** contract-change
- **Status:** proposed
- **Branch / PR:** claude/awesome-turing-2fh5e7
- **Blocking?:** no (UI shows what v1 provides; vitals/labs panel waits on this)

## Need
1. `allergies: string[]` cannot tell "no known allergies" (assessed) apart from "never recorded".
   The UI currently says "None recorded. Confirm with the patient", which is safe but less useful.
2. Clinicians need recent vitals and key labs next to the assistant (CLAUDE.md: critical context first).
3. Allergy severity/reaction would let the UI flag severe reactions.

## Proposed change (additive, v1.1.0)
```ts
export interface AllergyEntry { substance: string; reaction?: string; severity?: "mild" | "moderate" | "severe" | "unknown" }
export interface Observation { code: string; label: string; value: string; unit?: string; observedAt: IsoDateTime; abnormal?: boolean }

export interface PatientContext {
  // ...existing fields unchanged
  allergyStatus?: "known" | "no_known_allergies" | "unknown";
  allergyDetails?: AllergyEntry[];
  recentVitals?: Observation[];
  recentLabs?: Observation[];
}
```
All optional, so existing clients and the mock keep working. Schemas in `src/shared/schemas` and
synthetic data in `src/shared/mocks/synthetic-data.ts` need matching updates.

## Impact
Codex: schema, mock data, FHIR adapter mapping. Claude: allergy banner and a vitals/labs section in
`src/features/ehr-panel` once merged.

## Approvals
- [ ] Codex
- [x] Claude
- [ ] Integration owner
