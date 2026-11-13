import { expect, it } from "vitest";
import { createOpenAIProvider } from "@/core/agent/providers/openai-provider";
import { createConsultationService } from "@/core/consultation/service";
import { clinicalSafetyGuard } from "@/core/agent/safety/guard";
import { syntheticClinicalAdapter } from "@/integrations/mock/connector";
import { ahmedConsultationRequest } from "@/shared/mocks/synthetic-data";
import { getEnv } from "@/platform/tenants/env";
import { consultationDraftSchema } from "@/shared/schemas";

// Explicitly opt in to a paid call using an existing server-side key. Skipped is
// BLOCKED/unverified, never a successful live-provider criterion.
const enabled = process.env.RUN_OPENAI_SYNTHETIC_LIVE_TEST === "1" && Boolean(process.env.OPENAI_API_KEY);
it.skipIf(!enabled)("LIVE: typed grounded synthetic Ahmed consultation (requires secure credentials and explicit opt-in)", async () => {
  const env = getEnv();
  const provider = createOpenAIProvider({
    apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL,
    timeoutMs: env.OPENAI_TIMEOUT_MS, maxRetries: env.OPENAI_MAX_RETRIES,
    maxInputTokens: env.OPENAI_MAX_INPUT_TOKENS, maxOutputTokens: env.OPENAI_MAX_OUTPUT_TOKENS,
    maxCostUsd: env.OPENAI_MAX_COST_USD,
    inputUsdPerMillion: env.OPENAI_INPUT_USD_PER_MILLION, outputUsdPerMillion: env.OPENAI_OUTPUT_USD_PER_MILLION,
  });
  const service = createConsultationService({
    adapter: syntheticClinicalAdapter, provider, safety: clinicalSafetyGuard, dataClassification: "synthetic",
    repository: {
      async get() { throw new Error("Live test cannot read drafts"); },
      async create() { throw new Error("Live test cannot persist drafts"); },
      async approve() { throw new Error("Live test cannot approve drafts"); },
    },
  });
  const draft = consultationDraftSchema.parse(await service.preview(ahmedConsultationRequest, ahmedConsultationRequest));
  expect(draft.grounding?.provenance.provider).toBe("openai");
  expect(draft.grounding?.evidenceIds).toHaveLength(4);
  expect(draft.missingInformation?.filter((fact) => fact.category === "investigation")).toHaveLength(5);
  expect(draft.status).toBe("pending_approval");
}, 65_000);
