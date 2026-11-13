import { z } from "zod";
import { DATA_CLASSIFICATIONS } from "@/shared/constants";
import type { DataClassification, DataSource } from "@/shared/contracts";

export const dataClassificationSchema = z.enum(DATA_CLASSIFICATIONS) satisfies z.ZodType<DataClassification>;

/** The synthetic connector yields synthetic data; every EHR source yields live data. */
export function classificationOfSource(source: DataSource): DataClassification {
  return source === "synthetic" ? "synthetic" : "live";
}

/**
 * Legacy read compatibility. Records stored before data classification existed carry
 * `syntheticOnly: true`; they read as `dataClassification: "synthetic"`. A record that
 * carries both fields is left unchanged so that strict validation rejects it.
 */
export function readLegacyClassification(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const { syntheticOnly, ...rest } = value as Record<string, unknown>;
  return syntheticOnly === true && !("dataClassification" in rest) ? { ...rest, dataClassification: "synthetic" } : value;
}
