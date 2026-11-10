import assert from "node:assert/strict";
import { test } from "node:test";
import { routeConsultation } from "../../core/consultation/routing.ts";
import { createMockConsultationTransport } from "../../integrations/mock/transport.ts";
import type { ConsultationDraft } from "../../shared/contracts/index.ts";

test("routing requires approval and an allowed recipient, and retries do not redirect the delivery", async () => {
  let draft: ConsultationDraft = {
    id: "demo", patientId: "synthetic", summary: "", assessment: "", plan: [],
    generatedBy: "ai", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    status: "pending_approval",
  };
  const repository = { get: async (id: string) => id === draft.id ? draft : null };
  const transport = createMockConsultationTransport();
  const recipients = new Set(["team-a", "team-b"]);
  assert.deepEqual(await routeConsultation(repository, transport, recipients, "other", "team-a"), { code: "not_found" });
  assert.deepEqual(await routeConsultation(repository, transport, recipients, draft.id, "team-a"), { code: "conflict" });
  assert.equal(await transport.status(draft.id), null);
  draft = { ...draft, status: "approved", reviewedBy: "clinician", reviewedAt: draft.updatedAt };
  assert.deepEqual(await routeConsultation(repository, transport, recipients, draft.id, "unapproved"), { code: "forbidden" });
  const result = await routeConsultation(repository, transport, recipients, draft.id, "team-a");
  assert.ok("delivery" in result);
  assert.equal(result.delivery.status, "responded");
  assert.deepEqual(await routeConsultation(repository, transport, recipients, draft.id, "team-a"), result);
  assert.deepEqual(await routeConsultation(repository, transport, recipients, draft.id, "team-b"), { code: "conflict" });
  assert.deepEqual(await transport.status(draft.id), result.delivery);
});
