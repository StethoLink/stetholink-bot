import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const compat = new FlatCompat({ baseDirectory: __dirname });

/**
 * Module boundaries (see docs/architecture/module-boundaries.md):
 *   features/* and app/(workspace) -> may import shared/* only (never server/*)
 *   server/*                        -> may import shared/* only (never features/*, app/*)
 *   shared/*                        -> may import nothing from app/features/server
 */
const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    files: ["src/features/**", "src/app/(workspace)/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [
        { group: ["@/server", "@/server/*"], message: "Frontend must not import server code. Use the HTTP contract in @/shared/contracts." },
        { group: ["@/app/api/*"], message: "Frontend must not import API route handlers." },
      ] }],
    },
  },
  {
    files: ["src/server/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [
        { group: ["@/features/*", "@/app/*"], message: "Server code must not depend on UI code." },
      ] }],
    },
  },
  {
    files: ["src/shared/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [
        { group: ["@/features/*", "@/app/*", "@/server", "@/server/*"], message: "shared/ is a leaf: it must not import from app, features, or server." },
      ] }],
    },
  },
  { ignores: ["node_modules/**", ".next/**", "out/**", "build/**", "next-env.d.ts"] },
];

export default eslintConfig;
