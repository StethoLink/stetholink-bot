# ADR 0002: Model providers and clinical integrations behind interfaces

- Status: Accepted · Date: 2026-11-09

## Decision
- The orchestrator depends on `ModelProvider`. OpenAI (Responses API) is one implementation, selected by `AI_PROVIDER`.
- Clinical data comes from a `ClinicalDataAdapter` (synthetic or SMART on FHIR) and EHR launch context from an `EhrAdapter`.
- The LLM reaches data only through allowlisted tools, never through the database client.
- AI output stays a recommendation. Clinician approval is a separate authenticated endpoint with its own audit table.

## Consequences
Providers and hospital systems can be swapped without changing routes or UI. There is a small amount of extra interface code.
