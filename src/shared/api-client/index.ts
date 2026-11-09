import { createHttpApiClient } from "./http-client";
import { createMockApiClient } from "./mock-client";
import type { StethoLinkApiClient } from "./types";

export { ApiClientError } from "./errors";
export { createHttpApiClient } from "./http-client";
export { createMockApiClient } from "./mock-client";
export type { StethoLinkApiClient } from "./types";

/** Selects the client from NEXT_PUBLIC_API_MODE ("mock" | "http"). Defaults to "mock". */
export function createApiClient(): StethoLinkApiClient {
  return process.env.NEXT_PUBLIC_API_MODE === "http" ? createHttpApiClient() : createMockApiClient({ latencyMs: 300 });
}

let singleton: StethoLinkApiClient | undefined;
/** Process-wide default client for the browser. Tests should pass their own client. */
export function getApiClient(): StethoLinkApiClient {
  return (singleton ??= createApiClient());
}
