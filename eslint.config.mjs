// LOCKED: integration review required (see docs/architecture/ARCHITECTURE.md §6).
import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const compat = new FlatCompat({ baseDirectory: __dirname });

const restrict = (patterns) => ({ "no-restricted-imports": ["error", { patterns }] });
const NO_SERVER = { group: ["@/server", "@/server/*", "server-only"], message: "UI code must not import server code. Use @/shared/api-client." };
const NO_API = { group: ["@/app/api/*"], message: "Do not import route handlers." };
const NO_UI = { group: ["@/features/*", "@/app/*"], message: "Server code must not depend on UI code." };
const NO_DB_FROM_AI = { group: ["@/server/database", "@/server/database/*"], message: "AI code must not access the database directly. Expose a narrow tool in ai/tools that calls a service." };
const NO_DEEP_FEATURE = { group: ["@/features/*/*"], message: "Import a feature through its public index (e.g. @/features/assistant)." };

/** Module boundaries. Canonical description: docs/architecture/ARCHITECTURE.md §3. */
const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  { files: ["src/features/**", "src/app/(workspace)/**"], rules: restrict([NO_SERVER, NO_API, NO_DEEP_FEATURE]) },
  { files: ["src/server/**"], rules: restrict([NO_UI]) },
  { files: ["src/server/ai/**"], rules: restrict([NO_UI, NO_DB_FROM_AI]) },
  { files: ["src/shared/**"], rules: restrict([NO_SERVER, NO_UI]) },
  { files: ["src/app/api/**"], rules: restrict([NO_UI]) },
  { ignores: ["node_modules/**", ".next/**", "out/**", "build/**", "next-env.d.ts"] },
];

export default eslintConfig;
