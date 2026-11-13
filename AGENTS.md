# Repository guidance

Follow the module boundaries in [Architecture](docs/architecture/ARCHITECTURE.md).

- Core consumes interfaces and has no EHR, persistence, UI or framework dependency.
- Derive clinician identity from a verified server session. Keep credentials server-side.
- Real patient data may be processed at runtime only through the verified EHR session of a tenant configured for live clinical data. Never commit real patient data, and use synthetic or fictional fixtures in development and automated tests.
- Validate HTTP inputs and outputs. Keep patient data, secrets, OAuth parameters and model payloads out of logs.
- Only the physician approval path may approve a draft. Routing must read the approved state and enforce the tenant recipient allowlist.
- Run `npm run check`, `npm run build` and the Node smoke tests before pushing.

## Two agents, one `main`

Claude Code and Codex both work on every layer (core, platform, integrations, database, UI). There are no ownership zones and no pull requests: both commit to `main` directly. To avoid overwriting or missing each other's work:

1. **Sync before anything.** `git fetch origin && git rebase origin/main`. Read [the workboard](docs/coordination/WORKBOARD.md) and `git log --stat <last commit you saw>..origin/main` so you know what the other agent changed.
2. **Claim before coding.** Set a task's status to `claimed (<agent>)` on the workboard, commit it alone (`board: <agent> claims T<n>`) and push at once. If the push is rejected, rebase and re-read: if the other agent claimed it first, take another task.
3. **Small, frequent pushes.** Commit each coherent step and push it. Do not hold unpushed work for more than about an hour. Prefix commits with `[claude]` or `[codex]`.
4. **Push safely.** Run the checks above, then `git pull --rebase origin main`. If the rebase brought in changes, run the checks again. Then `git push origin HEAD:main`. Never force-push `main`, never rewrite pushed history.
5. **Resolve conflicts by keeping both intents.** Never drop the other agent's code to make a rebase pass. If you cannot tell what it should be, keep theirs, finish yours around it, and ask in the workboard log.
6. **Announce interface changes.** Any change to `shared/` contracts or schemas, a migration, an env variable, a port in `core/`, or an HTTP route is listed under *Interface changes* on the workboard in the same commit.
7. **Migrations.** Never edit a migration that is already on `main`. Reserve the new file name on the workboard when you claim the task.
8. **Finish a task.** Mark it `done (<agent>)`, write a log entry (what changed, what the other agent must know or do next) and push.
9. **If `main` is red,** whoever broke it fixes it before anything else; the other agent does not pile on unrelated changes.
