import "server-only";
import type { TransactionSql } from "postgres";
import type { ClinicianContext } from "@/core/auth/clinician";
import { database } from "./database";

/**
 * Runs one unit of work in a transaction whose every statement sees the verified session: the clinician, chart and data
 * classification that the row-level policies and the commands check (`stetholink.context`). Nothing is read or written outside it.
 */
export function scopedTo(context: ClinicianContext) {
  return function scoped<T>(work: (tx: TransactionSql) => Promise<T>): Promise<T> {
    return database().begin(async (tx) => {
      await tx`select set_config('statement_timeout', '10000', true), set_config('lock_timeout', '5000', true),
        set_config('stetholink.context', ${JSON.stringify(context)}, true)`;
      return await work(tx);
    }) as Promise<T>;
  };
}
