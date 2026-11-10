# Repository guidance

Follow the module boundaries in [Architecture](docs/architecture/ARCHITECTURE.md).

- Core consumes interfaces and has no EHR, persistence, UI or framework dependency.
- Derive clinician identity from a verified server session. Keep credentials server-side, and use synthetic data in development and automated tests.
- Validate HTTP inputs and outputs. Keep patient data, secrets, OAuth parameters and model payloads out of logs.
- Only the physician approval path may approve a draft. Routing must read the approved state and enforce the tenant recipient allowlist.
- Run `npm run check`, `npm run build` and the Node smoke tests before pushing. Respect GitHub branch protection and ownership rules.
