import "server-only";

/**
 * Fixed-window request limit kept in this server process. It bounds what one sender can ask of
 * one instance; it is not shared between instances, so the limits are set with that in mind.
 * Keys are identifiers (a provider id, a specialist id, a hashed address), never content.
 */
const globals = globalThis as typeof globalThis & { stetholinkRateWindows?: Map<string, { start: number; count: number }> };
export function allowRequest(key: string, limit: number, windowMs: number, now = Date.now()) {
  const windows = globals.stetholinkRateWindows ??= new Map();
  if (windows.size > 10_000) for (const [name, window] of windows) if (now - window.start >= windowMs) windows.delete(name);
  const current = windows.get(key);
  if (!current || now - current.start >= windowMs) { windows.set(key, { start: now, count: 1 }); return true; }
  current.count++;
  return current.count <= limit;
}
