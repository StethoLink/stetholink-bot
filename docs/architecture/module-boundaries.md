# Module Boundaries

| From \ To | shared | server | features | app/api |
|---|---|---|---|---|
| shared | ✅ | ❌ | ❌ | ❌ |
| server | ✅ | ✅ | ❌ | ❌ |
| features / (workspace) | ✅ | ❌ | ✅ (via `features/<x>/index.ts`) | ❌ (HTTP only) |
| app/api | ✅ | ✅ (`@/server` only) | ❌ | — |

Enforced in `eslint.config.mjs`. `server/index.ts` imports `server-only`, so accidental client bundling fails the build.
Features expose a public API via their `index.ts`; import other features only through it.
