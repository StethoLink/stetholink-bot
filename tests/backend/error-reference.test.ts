import { afterEach, describe, expect, it, vi } from "vitest";
import { errorResponse, handleRouteError } from "@/apps/embedded-app/server/http/respond";
import { apiErrorSchema } from "@/shared/schemas";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));
const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
afterEach(() => log.mockClear());
const REFERENCE = /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/;

describe("the reference on an error", () => {
  it("is on a server-side failure, in the body and the header, and matches one log line", async () => {
    const response = errorResponse("provider_unavailable", "Database is temporarily unavailable");
    const body = apiErrorSchema.parse(await response.json());
    expect(body.error.requestId).toMatch(REFERENCE);
    expect(response.headers.get("X-Correlation-Id")).toBe(body.error.requestId);
    expect(log).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(log.mock.calls[0][0])) as Record<string, string>;
    expect(Object.keys(line).sort()).toEqual(["action", "at", "code", "correlationId"]);
    expect(line).toMatchObject({ action: "api.request_failed", code: "provider_unavailable", correlationId: body.error.requestId });
  });

  it("never logs the message, which may quote the chart", async () => {
    const response = handleRouteError(new Error("patient Salma Alfaris, MRN 4471"));
    expect((await response.json()).error.message).toBe("Unexpected server error");
    expect(log.mock.calls.flat().join(" ")).not.toMatch(/Salma|4471/);
  });

  it.each(["invalid_request", "unauthenticated", "forbidden", "not_found", "conflict", "unsupported_encounter", "not_implemented", "safety_blocked"] as const)(
    "is absent from %s, which the server does not log", async (code) => {
      const response = errorResponse(code, "refused");
      expect(await response.json()).toEqual({ error: { code, message: "refused" } });
      expect(response.headers.get("X-Correlation-Id")).toBeNull();
      expect(log).not.toHaveBeenCalled();
    });

  it("uses the caller's reference without a second log line when the caller already logged the failure", async () => {
    const response = errorResponse("provider_unavailable", "The EHR is not answering", { correlationId: "AAAA-BBBB-CCCC" });
    expect((await response.json()).error.requestId).toBe("AAAA-BBBB-CCCC");
    expect(response.headers.get("X-Correlation-Id")).toBe("AAAA-BBBB-CCCC");
    expect(log).not.toHaveBeenCalled();
  });
});
