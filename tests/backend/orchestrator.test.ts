import { describe, expect, it } from "vitest";
import { createChatOrchestrator } from "@/core/agent/orchestrator/orchestrator";
import { mockProvider } from "@/core/agent/providers/mock-provider";
import { passthroughSafetyGuard } from "@/core/agent/safety/guard";
import { chatResponseSchema } from "@/shared/schemas";

describe("chat orchestrator", () => {
  const deps = { provider: mockProvider, safety: passthroughSafetyGuard, loadPatientContext: async () => null };

  it("returns a contract-valid response that requires clinician review", async () => {
    const res = chatResponseSchema.parse(await createChatOrchestrator(deps).handle({ message: "hello" }));
    expect(res.message.content).toContain("hello");
    expect(res.requiresClinicianReview).toBe(true);
  });

  it("withholds content when the safety guard blocks it", async () => {
    const o = createChatOrchestrator({ ...deps, safety: { assess: async () => ({ level: "blocked", reasons: ["x"] }) } });
    const res = await o.handle({ message: "hello" });
    expect(res.message.content).not.toContain("hello");
  });
});
