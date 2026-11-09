# Contract change process

Applies to everything in `src/shared/**` and to protected config files.

1. **Propose:** the requesting agent adds a handoff (`Type: contract-change`, `Status: proposed`) with before/after TypeScript.
2. **Approve:** Codex (contract owner), Claude, and the integration owner tick their approvals in a reply handoff. No implementation happens before approval.
3. **Implement:** Codex opens a **contract-only PR** that updates the interface, the schema, `docs/api-contracts/README.md`, the mock client if needed, and `CONTRACT_VERSION` (semver: additive = minor, breaking = major plus an ADR).
4. **Merge** to `main` after CI and Code Owner review.
5. **Rebase:** each agent rebases or merges `main` into its **own** branch.

Prefer additive changes (new optional fields, new routes). Never rename or remove a field without a major version and an ADR.
