import { describe, expect, it } from "vitest";
import { createOrchestrator } from "@/server/ai/orchestrator/orchestrator";
import { mockProvider } from "@/server/ai/providers/mock-provider";
import { safetyGuard } from "@/server/safety/guard";
import { assistantResponseSchema } from "@/shared/schemas";

describe("orchestrator", () => {
  it("returns a contract-valid response", async () => {
    const o = createOrchestrator({ provider: mockProvider, safety: safetyGuard });
    const res = await o.handle({ message: "hello" });
    expect(assistantResponseSchema.parse(res).reply.content).toContain("hello");
  });
});
