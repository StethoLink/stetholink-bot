import type { ApiErrorCode } from "@/shared/contracts";

export class RouteError extends Error {
  constructor(readonly code: ApiErrorCode, message: string) {
    super(message);
  }
}
