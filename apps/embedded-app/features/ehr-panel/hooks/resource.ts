import { ApiClientError } from "@/shared/api-client";
import type { ApiErrorCode } from "@/shared/contracts";

export type ResourceState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  /** `code` and `reference` are present when the server answered with an error (the reference only when it logged one). */
  | { status: "error"; message: string; code?: ApiErrorCode; reference?: string };

/** Runs a loader and reports each state transition. `isActive` guards against stale updates. */
export async function loadResource<T>(
  load: () => Promise<T>,
  set: (s: ResourceState<T>) => void,
  fallback: string,
  isActive: () => boolean = () => true,
): Promise<void> {
  set({ status: "loading" });
  try {
    const data = await load();
    if (isActive()) set({ status: "ready", data });
  } catch (e) {
    if (!isActive()) return;
    if (e instanceof ApiClientError) set({ status: "error", message: e.message, code: e.code, ...(e.requestId ? { reference: e.requestId } : {}) });
    else set({ status: "error", message: fallback });
  }
}
