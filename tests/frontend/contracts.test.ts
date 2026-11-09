import { describe, expect, it } from "vitest";
import { apiRoutes } from "@/shared/contracts";

describe("frontend contract usage", () => {
  it("rejects empty assistant messages before sending", () => {
    expect(apiRoutes.assistantMessage.request.safeParse({ message: "" }).success).toBe(false);
  });
});
