import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The running product never imports a fictional fixture or a test double (AGENTS.md; brief T3).
 * ESLint enforces the same rule in `eslint.config.mjs`; this check also follows relative paths,
 * re-exports, dynamic imports and require calls, and fails `npm run check` on its own.
 */
const root = resolve(import.meta.dirname, "../..");
const productRoots = ["apps", "core", "platform", "integrations", "shared", "scripts"];
const sourceFile = /\.(?:ts|tsx|mts|mjs|js)$/;

function filesIn(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === ".next") return [];
    const file = join(directory, entry.name);
    return entry.isDirectory() ? filesIn(file) : sourceFile.test(entry.name) ? [file] : [];
  });
}

function fixtureImports(file: string, source: string): string[] {
  return ts.preProcessFile(source, true, true).importedFiles.map(({ fileName }) => fileName).filter((specifier) => {
    if (!specifier.startsWith("@/") && !specifier.startsWith(".")) return false;
    const target = specifier.startsWith("@/") ? resolve(root, specifier.slice(2)) : resolve(dirname(file), specifier);
    const path = relative(root, target).replaceAll("\\", "/");
    return path === "tests" || path.startsWith("tests/") || /(?:^|\/)(?:fixtures|mocks|__mocks__)(?:\/|$)/.test(path);
  });
}

describe("no fixtures in the product", () => {
  it("finds no import of tests/, fixtures or mocks in apps, core, platform, integrations, shared or scripts", () => {
    const files = productRoots.flatMap((directory) => filesIn(join(root, directory)));
    expect(files.length).toBeGreaterThan(100);
    const violations = files.flatMap((file) => fixtureImports(file, readFileSync(file, "utf8")).map((specifier) => `${relative(root, file)} -> ${specifier}`));
    expect(violations).toEqual([]);
  });

  it.each([
    ['import { syntheticPatients } from "@/tests/fixtures/synthetic-data";', "platform/tenants/example.ts"],
    ['import { mockProvider } from "../../tests/fixtures/mock-provider";', "platform/tenants/example.ts"],
    ['export * from "../../../tests/fixtures/clinical-adapter";', "integrations/fhir/example.ts"],
    ['const double = await import("@/tests/fixtures/transcription");', "apps/embedded-app/server/example.ts"],
    ['const double = require("@/tests/helpers/config");', "core/scribe/example.ts"],
    ['import type { Chart } from "./fixtures/chart";', "core/tools/example.ts"],
    ['import { data } from "@/shared/mocks/synthetic-data";', "shared/api-client/example.ts"],
  ])("detects %s", (source, file) => {
    expect(fixtureImports(join(root, file), source)).toHaveLength(1);
  });

  it("leaves no fixture module behind in the product tree", () => {
    for (const path of ["shared/mocks", "integrations/mock", "core/agent/providers/mock-provider.ts", "integrations/transcription/mock.ts", "shared/api-client/mock-client.ts",
      "apps/embedded-app/app/api/staging", "apps/embedded-app/app/(workspace)/staging", "apps/embedded-app/server/consultation-demo.ts", "scripts/demo.mjs"]) {
      expect(existsSync(join(root, path)), path).toBe(false);
    }
  });
});
