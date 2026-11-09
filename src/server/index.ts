import "server-only";
import { createOrchestrator } from "@/server/ai/orchestrator/orchestrator";
import { mockProvider } from "@/server/ai/providers/mock-provider";
import { safetyGuard } from "@/server/safety/guard";

/** Composition root. API route handlers import from here only. */
export const assistantOrchestrator = createOrchestrator({ provider: mockProvider, safety: safetyGuard });
