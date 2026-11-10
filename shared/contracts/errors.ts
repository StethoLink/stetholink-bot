import type { API_ERROR_CODES } from "@/shared/constants";

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiError {
  error: {
    code: ApiErrorCode;
    message: string;
    requestId?: string;
  };
}
