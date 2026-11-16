import "server-only";
import { readFileSync, statSync } from "node:fs";
import type { OrderCatalog } from "@/shared/contracts";
import { orderCatalogSchema } from "@/shared/schemas";
import { ORDER_FACTS_ALLOWANCE_BYTES, orderRequestFloorBytes } from "@/core/orders/authoring";
import { ServerConfigurationError, getEnv, type ServerEnv } from "./env";

export const MAX_CATALOG_FILE_BYTES = 2_000_000;

/**
 * The hospital's order catalog, read from the file `ORDER_CATALOG_FILE` names. The product carries no clinical content:
 * the orders, their codes, the medications with their doses and the interaction rules are the hospital's own.
 * A file that cannot be read, is not a valid catalog, or is too large to send to the model with a chart stops the server
 * from starting. Messages name the setting and the place in the file, never what the file says.
 */
export function loadOrderCatalog(env: Pick<ServerEnv, "ORDER_CATALOG_FILE" | "ORDER_MAX_INPUT_TOKENS" | "OPENAI_MAX_INPUT_TOKENS">): OrderCatalog | null {
  const path = env.ORDER_CATALOG_FILE;
  if (!path) return null;
  let raw: string;
  try {
    if (statSync(path).size > MAX_CATALOG_FILE_BYTES) throw new ServerConfigurationError("ORDER_CATALOG_FILE is larger than 2 MB");
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof ServerConfigurationError) throw error;
    throw new ServerConfigurationError("ORDER_CATALOG_FILE cannot be read");
  }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new ServerConfigurationError("ORDER_CATALOG_FILE is not valid JSON"); }
  const parsed = orderCatalogSchema.safeParse(value);
  if (!parsed.success) {
    const where = parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".") || "catalog"}: ${issue.message}`).join("; ");
    throw new ServerConfigurationError(`ORDER_CATALOG_FILE is not a valid order catalog (${where})`);
  }
  const limit = env.ORDER_MAX_INPUT_TOKENS ?? env.OPENAI_MAX_INPUT_TOKENS;
  const needed = orderRequestFloorBytes(parsed.data) + ORDER_FACTS_ALLOWANCE_BYTES;
  if (needed > limit) {
    throw new ServerConfigurationError(`The order catalog is too large to send to the model with a chart: it needs about ${needed} bytes and the limit is ${limit} (raise ORDER_MAX_INPUT_TOKENS, at most 120000, or remove orders)`);
  }
  return parsed.data;
}

let cached: { catalog: OrderCatalog | null } | undefined;
/** The tenant's catalog, or null when order drafting is not set up. Read once per server process. */
export function getOrderCatalog(): OrderCatalog | null {
  return (cached ??= { catalog: loadOrderCatalog(getEnv()) }).catalog;
}
