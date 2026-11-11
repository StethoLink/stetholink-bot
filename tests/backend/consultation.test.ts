import { describe, expect, it, vi } from "vitest";
import { createConsultationService } from "@/core/consultation/service";
import type { ClinicianContext } from "@/core/auth/clinician";
import { syntheticClinicalAdapter } from "@/integrations/mock/connector";
import { mockProvider } from "@/core/agent/providers/mock-provider";
import { syntheticSafetyGuard } from "@/core/agent/safety/guard";

const actor: ClinicianContext = {
  clinicianId: "11111111-1111-4111-8111-111111111111", tenantId: "synthetic", roles: ["physician"],
  scopes: ["consultation:draft", "consultation:approve"], patientId: "syn-pt-001", encounterId: "syn-enc-001",
  expiresAt: Date.now() + 600_000, authorization: "active",
};

describe("consultation generation", () => {
  function setup() {
    const repository = { get: vi.fn(), approve: vi.fn(), create: vi.fn(async (draft) => draft) };
    const deps = { repository, provider: mockProvider, safety: syntheticSafetyGuard, adapter: syntheticClinicalAdapter };
    return { deps, repository };
  }

  it("saves a pending draft with provenance and binds the session owner and encounter", async () => {
    const { deps, repository } = setup();
    const result = await createConsultationService(deps).create({ patientId: "syn-pt-001" }, actor);
    expect(result).toMatchObject({ status: "pending_approval", encounterId: "syn-enc-001" });
    expect(repository.create).toHaveBeenCalledWith(result, actor.clinicianId, { provider: "mock", model: "mock-1", promptVersion: "system@0.1.0" });
  });

  it("never saves blocked model output", async () => {
    const { deps, repository } = setup();
    deps.safety = { assess: async () => ({ level: "blocked", reasons: [] }) };
    await expect(createConsultationService(deps).create({ patientId: "syn-pt-001" }, actor)).rejects.toMatchObject({ code: "safety_blocked" });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("rejects mismatched patients and unsupported conversation references", async () => {
    const { deps } = setup();
    await expect(createConsultationService(deps).create({ patientId: "missing" }, actor)).rejects.toMatchObject({ code: "forbidden" });
    await expect(createConsultationService(deps).create({ patientId: "syn-pt-001", conversationId: "missing" }, actor)).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("rejects approval from a clinician without the physician role", async () => {
    const { deps, repository } = setup();
    await expect(createConsultationService(deps).approve({ draftId: "synthetic", decision: "approve" },
      { ...actor, roles: ["clinician"] })).rejects.toMatchObject({ code: "forbidden" });
    expect(repository.approve).not.toHaveBeenCalled();
  });

  it.each(["", "<script>unsafe</script>", "Consultation was approved.", "You should increase taking medication.", "\u202eunsafe"])(
    "blocks unsafe synthetic output (%s)", async (value) => {
      expect((await syntheticSafetyGuard.assess(value)).level).toBe("blocked");
    },
  );
});
