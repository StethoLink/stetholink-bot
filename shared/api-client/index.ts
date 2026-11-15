import { createHttpApiClient } from "./http-client";
import type { StethoLinkApiClient } from "./types";

export { ApiClientError } from "./errors";
export { createHttpApiClient } from "./http-client";
export type { StethoLinkApiClient } from "./types";

/** The browser talks to the server over HTTP only. There is no in-memory client. */
export function createApiClient(): StethoLinkApiClient {
  return createHttpApiClient();
}

let singleton: StethoLinkApiClient | undefined;
/** Process-wide default client for the browser. Tests should pass their own client. */
export function getApiClient(): StethoLinkApiClient {
  return (singleton ??= createApiClient());
}
