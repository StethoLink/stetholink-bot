import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ORDER_FACTS_ALLOWANCE_BYTES, orderRequestFloorBytes } from "@/core/orders/authoring";
import { MAX_CATALOG_FILE_BYTES, loadOrderCatalog } from "@/platform/tenants/order-catalog";
import type { OrderCatalog } from "@/shared/contracts";
import { completeConfig } from "@/tests/helpers/config";
import { ORDER_CATALOG, orderItem } from "@/tests/fixtures/orders";

/** The hospital's catalog is its own file. Every order and value here is fictional. */
const directory = mkdtempSync(join(tmpdir(), "stetholink-orders-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); vi.restoreAllMocks(); });
const write = (name: string, content: unknown) => {
  const path = join(directory, name);
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
};
const env = (file?: string, limits: { order?: number; model?: number } = {}) => ({ ORDER_CATALOG_FILE: file, ORDER_MAX_INPUT_TOKENS: limits.order, OPENAI_MAX_INPUT_TOKENS: limits.model ?? 16_000 });
/** A catalog of `count` fictional orders, each with a few names, as a hospital's would have. */
const large = (count: number): OrderCatalog => ({
  ...ORDER_CATALOG,
  items: Array.from({ length: count }, (_, index) => orderItem({ id: `lab-${String(index).padStart(4, "0")}`, kind: "lab", display: `Fictional laboratory test number ${index}`, synonyms: [`FLT${index}`, `اختبار خيالي ${index}`] })),
  sets: [], interactions: [],
});

describe("the hospital's order catalog file", () => {
  it("is not offered when no file is configured", () => {
    expect(loadOrderCatalog(env())).toBeNull();
  });

  it("is read and checked from the configured file, once the server starts", () => {
    expect(loadOrderCatalog(env(write("good.json", ORDER_CATALOG)))).toEqual(ORDER_CATALOG);
  });

  it("stops the server from starting when the file is missing, is not JSON, or is not a catalog, without echoing what it holds", () => {
    expect(() => loadOrderCatalog(env(join(directory, "missing.json")))).toThrow(/ORDER_CATALOG_FILE cannot be read/);
    expect(() => loadOrderCatalog(env(join(directory, "missing.json")))).not.toThrow(new RegExp(directory.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
    expect(() => loadOrderCatalog(env(write("notjson.json", "{ not json")))).toThrow(/not valid JSON/);
    // A laboratory test that carries a dose: refused, and the message names the place, never the dose.
    const bad = structuredClone(ORDER_CATALOG);
    bad.items[0].medication = { product: "Secret product", dose: "9999 mg", route: "oral", frequency: "daily" };
    let message = "";
    try { loadOrderCatalog(env(write("bad.json", bad))); } catch (error) { message = (error as Error).message; }
    expect(message).toMatch(/not a valid order catalog/);
    expect(message).toMatch(/items\.0\.medication/);
    for (const value of ["9999 mg", "Secret product", "CBC-1"]) expect(message).not.toContain(value);
    // A catalog with an order set that names an order it does not hold, and one with no orders at all.
    const dangling = structuredClone(ORDER_CATALOG);
    dangling.sets[0].itemIds.push("not-in-catalog");
    expect(() => loadOrderCatalog(env(write("dangling.json", dangling)))).toThrow(/not a valid order catalog/);
    expect(() => loadOrderCatalog(env(write("empty.json", { ...ORDER_CATALOG, items: [], sets: [] })))).toThrow(/not a valid order catalog/);
  });

  it("refuses a file larger than 2 MB", () => {
    expect(() => loadOrderCatalog(env(write("huge.json", JSON.stringify({ filler: "x".repeat(MAX_CATALOG_FILE_BYTES + 1) }))))).toThrow(/larger than 2 MB/);
  });

  it("refuses a catalog too large to send to the model with a chart, and says which setting to raise", () => {
    const path = write("large.json", large(400));
    expect(orderRequestFloorBytes(large(400)) + ORDER_FACTS_ALLOWANCE_BYTES).toBeGreaterThan(16_000);
    expect(() => loadOrderCatalog(env(path))).toThrow(/too large to send to the model.*ORDER_MAX_INPUT_TOKENS/);
    expect(() => loadOrderCatalog(env(path, { model: 32_000 }))).toThrow(/too large/);
    // Order drafting has its own, larger limit for exactly this.
    expect(loadOrderCatalog(env(path, { order: 120_000 }))?.items).toHaveLength(400);
    // The small test catalog fits the default limit with room for a chart.
    expect(orderRequestFloorBytes(ORDER_CATALOG) + ORDER_FACTS_ALLOWANCE_BYTES).toBeLessThan(16_000);
  });
});

describe("starting the server", () => {
  async function register(file?: string) {
    vi.resetModules();
    for (const [name, value] of Object.entries({ ...completeConfig, ...(file ? { ORDER_CATALOG_FILE: file } : {}), NEXT_RUNTIME: "nodejs" })) vi.stubEnv(name, value);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await (await import("@/apps/embedded-app/instrumentation")).register();
    return { exit, message: String(error.mock.calls[0]?.[1] ?? "") };
  }

  it("starts with a valid catalog, and without one", async () => {
    expect((await register(write("start-good.json", ORDER_CATALOG))).exit).not.toHaveBeenCalled();
    expect((await register()).exit).not.toHaveBeenCalled();
  });

  it("refuses to start with a catalog that cannot be used", async () => {
    const started = await register(write("start-bad.json", { ...ORDER_CATALOG, items: [{ ...ORDER_CATALOG.items[0], kind: "pharmacy" }] }));
    expect(started.exit).toHaveBeenCalledWith(1);
    expect(started.message).toMatch(/not a valid order catalog/);
  });
});
