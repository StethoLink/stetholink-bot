import type { SpendingLimiter } from "./types";

/**
 * In-process spending limit over a fixed window (default one UTC day). It bounds what one
 * server instance can spend; it is not a billing ledger and does not span instances.
 */
export function createSpendingLimiter(limitUsd: number, options: { windowMs?: number; now?: () => number } = {}): SpendingLimiter {
  const windowMs = options.windowMs ?? 86_400_000;
  const now = options.now ?? Date.now;
  let windowStart = Math.floor(now() / windowMs) * windowMs;
  let spent = 0;
  function roll() {
    const current = Math.floor(now() / windowMs) * windowMs;
    if (current !== windowStart) { windowStart = current; spent = 0; }
  }
  return {
    reserve(usd) {
      roll();
      if (!Number.isFinite(usd) || usd < 0 || spent + usd > limitUsd) throw new Error("Model spending limit reached");
      spent += usd;
      const reservedIn = windowStart;
      let open = true;
      return {
        settle(actualUsd) {
          if (!open) return;
          open = false;
          // A reservation from an earlier window was already discarded with that window.
          if (reservedIn === windowStart) spent = Math.max(0, spent - usd + Math.min(Math.max(actualUsd, 0), usd));
        },
      };
    },
    snapshot() {
      roll();
      return { limitUsd, spentUsd: spent, windowStartedAt: new Date(windowStart).toISOString() };
    },
  };
}
