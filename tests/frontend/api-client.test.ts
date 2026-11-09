import { describe, expect, it } from "vitest";
import { ApiClientError, createHttpApiClient, createMockApiClient } from "@/shared/api-client";

describe("mock API client", () => {
  it("serves synthetic patient context", async () => {
    const p = await createMockApiClient().getPatientContext("syn-pt-001");
    expect(p.source).toBe("synthetic");
  });

  it("enforces the approval lifecycle", async () => {
    const c = createMockApiClient();
    expect((await c.submitApproval({ draftId: "syn-draft-001", decision: "approve" })).status).toBe("approved");
    await expect(c.submitApproval({ draftId: "syn-draft-001", decision: "approve" })).rejects.toBeInstanceOf(
      ApiClientError,
    );
  });
});

describe("HTTP API client", () => {
  it("rejects responses that violate the contract", async () => {
    const fetch = async () => new Response(JSON.stringify({ wrong: true }), { status: 200 });
    await expect(createHttpApiClient({ fetch }).health()).rejects.toMatchObject({ code: "internal_error" });
  });

  it("maps ApiError bodies", async () => {
    const fetch = async () =>
      new Response(JSON.stringify({ error: { code: "not_found", message: "nope" } }), { status: 404 });
    await expect(createHttpApiClient({ fetch }).getPatientContext("x")).rejects.toMatchObject({ code: "not_found" });
  });
});
