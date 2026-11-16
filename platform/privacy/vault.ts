import "server-only";
import type { SurrogateVault } from "@/core/privacy/ports";
import type { SurrogateState } from "@/core/privacy/pseudonymizer";

/**
 * Stand-in maps, one per signed-in session, in this server's memory only. A map holds the real
 * names and identifiers it replaced, so it is never written to the database, a log or a response,
 * and it is dropped when its session expires. After a restart, or on another instance, a session
 * simply gets a new map: each model call maps its own answer back, so nothing depends on the map
 * surviving; only the choice of stand-in names may differ between two requests.
 */
const MAX_SESSIONS = 2000;
const globals = globalThis as typeof globalThis & { stetholinkSurrogates?: Map<string, { state: SurrogateState; expiresAt: number }> };

export function createMemoryVault(now: () => number = Date.now, store = globals.stetholinkSurrogates ??= new Map()): SurrogateVault<SurrogateState> {
  return {
    open(sessionKey, expiresAt, create) {
      const time = now();
      for (const [key, entry] of store) if (entry.expiresAt <= time) store.delete(key);
      const held = store.get(sessionKey);
      if (held) return held.state;
      const state = create();
      // An expired session keeps nothing; a full store drops its oldest map.
      if (expiresAt > time) {
        if (store.size >= MAX_SESSIONS) store.delete(store.keys().next().value!);
        store.set(sessionKey, { state, expiresAt });
      }
      return state;
    },
  };
}
