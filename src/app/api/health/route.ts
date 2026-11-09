import { CONTRACT_VERSION } from "@/shared/constants";
import { healthResponseSchema } from "@/shared/schemas";
import { contractResponse } from "@/server";

export function GET() {
  return contractResponse(healthResponseSchema, { status: "ok", contractVersion: CONTRACT_VERSION });
}
