# M3 review handoff

The user's official M3 instruction authorizes durable consultation lifecycle work
in `core/m3-durable-lifecycle`, including persistence contracts, migration and
restart tests. Integration and frontend review are requested for the shared and
owned paths below; this document does not claim that review has occurred.

- Shared contracts/constants/schemas add optional durable identity/version fields,
  the legacy pending-review alias, revision/transition commands and bounded history.
- Frontend changes only recognize the additional statuses and prevent decisions
  on terminal lifecycle states. No new standalone login or expanded UI is added.
- `tests/e2e/run-ci.sh` reuses its disposable PostgreSQL setup for migration tests
  and adds app-process restart verification after the existing smoke run.
- API and test documentation describe compatibility, mock delivery and the limits
  of local verification. No production settings or deployment files change.

Core prompt/evaluation files, the Ahmed fixture and ClinicalFact contracts are
unchanged. Review shared contracts and CI changes with integration ownership
before merging. Do not merge or deploy as part of this task.
