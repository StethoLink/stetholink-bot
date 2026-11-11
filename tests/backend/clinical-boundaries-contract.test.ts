import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const sharedModules = ["contracts", "schemas", "constants", "types", "utils"].map((name) => `shared/${name}/`);
const permittedModules = ["core/", ...sharedModules];

function filesIn(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? filesIn(file) : file.endsWith(".ts") ? [file] : [];
  });
}

function forbiddenImports(file: string, source: string): string[] {
  return ts.preProcessFile(source, true, true).importedFiles.flatMap(({ fileName: specifier }) => {
    if (specifier === "zod") return [];
    if (!specifier.startsWith("@/") && !specifier.startsWith(".")) return [specifier];
    const target = specifier.startsWith("@/") ? resolve(root, specifier.slice(2)) : resolve(dirname(file), specifier);
    const path = relative(root, target).replaceAll("\\", "/") + "/";
    const allowed = relative(root, file).replaceAll("\\", "/").startsWith("core/") ? permittedModules : sharedModules;
    return allowed.some((prefix) => path.startsWith(prefix)) ? [] : [specifier];
  });
}

describe("clinical contract module boundaries", () => {
  it("keeps all Core and shared contract dependencies inside the permitted modules", () => {
    // Check every file in the allowed dependency graph, including type-only imports and
    // re-exports, so shared barrels cannot hide a transitive integration dependency.
    const files = ["core", ...sharedModules].flatMap((directory) => filesIn(join(root, directory)));
    const violations = files.flatMap((file) => forbiddenImports(file, readFileSync(file, "utf8")).map((specifier) => `${relative(root, file)} -> ${specifier}`));
    expect(violations).toEqual([]);
  });

  it.each([
    'import type { Vendor } from "@/integrations/fhir/connector";',
    'export * from "../../integrations/mock/connector";',
    'import { cookies } from "next/headers";',
    'import { store } from "@/platform/persistence/repository";',
    'import { View } from "@/apps/embedded-app/features/ehr-panel";',
    'const vendor = import("@/integrations/openemr/connector");',
    'const vendor = require("@/integrations/openemr/connector");',
  ])("detects a forbidden dependency (%#)", (source) => {
    expect(forbiddenImports(join(root, "core/tools/example.ts"), source)).toHaveLength(1);
  });

  it("keeps shared contracts independent of Core and implementation fixtures", () => {
    expect(forbiddenImports(join(root, "shared/contracts/example.ts"), 'export type { ClinicalDataAdapter } from "@/core/tools/connector";')).toHaveLength(1);
    expect(forbiddenImports(join(root, "core/tools/example.ts"), 'import { syntheticPatients } from "@/shared/mocks/synthetic-data";')).toHaveLength(1);
  });
});
