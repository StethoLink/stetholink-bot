# Architecture Overview

```
Browser ── (workspace) pages ── features/* ──fetch──► app/api/* ──► server/index.ts (composition root)
                                     │                    │                │
                                     └──── shared/contracts, schemas, types ┘
                                                                         ├─ ai/{orchestrator,prompts,providers,tools,evaluations}
                                                                         ├─ clinical/{patient-context,consultation,workflows}
                                                                         ├─ integrations/{fhir,ehr,external-services}
                                                                         └─ auth, database (Supabase), safety
```

- **Single seam:** frontend and backend meet only at `src/shared/contracts` (Zod schemas + route table). Both sides validate at runtime.
- **Dependency injection:** `server/index.ts` wires concrete providers into interfaces from `shared/contracts/services.ts`, so the AI provider, FHIR source, or DB can be swapped without touching routes.
- **Safety first:** every assistant reply passes through `server/safety` before leaving the server.
- **Mock-first:** the `mock` AI provider lets the frontend run end-to-end without API keys.

See [module-boundaries.md](./module-boundaries.md).
