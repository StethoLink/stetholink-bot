import "server-only";
import type { SpendingLimiter } from "@/core/agent/providers/types";
import { database } from "./database";

/**
 * Daily spending limit held in PostgreSQL, shared by every instance of the server and kept across
 * restarts. A reservation that cannot be recorded is refused: no call is made without a ledger row.
 */
export function createLedgerLimiter(tenantId: string, kind: "model" | "transcription", dailyLimitUsd: number): SpendingLimiter {
  return {
    async reserve(usd, task = kind) {
      const [row] = await database()`select public.reserve_spend(${tenantId}, ${kind}, ${task}, ${usd}, ${dailyLimitUsd}) as id`;
      const id = row.id as string;
      let open = true;
      return {
        async settle(actualUsd) {
          if (!open) return;
          open = false;
          // A failed settlement leaves the full reservation counted, which errs on the side of the limit.
          await database()`select public.settle_spend(${id}, ${actualUsd})`.catch(() => undefined);
        },
      };
    },
  };
}
