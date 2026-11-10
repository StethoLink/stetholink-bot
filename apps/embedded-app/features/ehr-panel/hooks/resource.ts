import { ApiClientError } from "@/shared/api-client";

export type ResourceState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; message: string };

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
    if (isActive()) set({ status: "error", message: e instanceof ApiClientError ? e.message : fallback });
  }
}
