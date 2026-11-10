import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });
const ui = "@/apps/embedded-app/features";
const app = "@/apps/embedded-app/app";
const server = "@/apps/embedded-app/server";
const restrict = (patterns) => ({ "no-restricted-imports": ["error", { patterns }] });

export default [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  { settings: { next: { rootDir: "apps/embedded-app/" } } },
  {
    files: ["apps/embedded-app/features/**/*.{ts,tsx}", "shared/api-client/**/*.ts"],
    rules: restrict([{ group: [server, `${server}/**`, `${app}/**`, "@/platform/**", "@/integrations/**", "server-only"], message: "Use the app's HTTP client from browser code." }]),
  },
  {
    files: ["core/**/*.ts"],
    rules: restrict([{ group: ["@/apps/**", "@/platform/**", "@/integrations/**", "**/platform/**", "**/integrations/**", "next", "next/**"], message: "Core logic receives implementations through interfaces." }]),
  },
  {
    files: ["platform/**/*.ts", "integrations/**/*.ts", "apps/embedded-app/server/**/*.ts", "apps/embedded-app/app/api/**/*.ts"],
    rules: restrict([{ group: [ui, `${ui}/**`, `${app}/**`], message: "Server code cannot depend on app UI or route handlers." }]),
  },
  { ignores: ["**/node_modules/**", "**/.next/**", "**/out/**", "**/build/**", "**/next-env.d.ts"] },
];
