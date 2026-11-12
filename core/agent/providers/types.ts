import type { ModelUsage } from "@/shared/contracts";

/** Provider-neutral model interface. The orchestrator depends only on this. */
export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelRequest {
  instructions: string;
  messages: ModelMessage[];
  /** Set only after validating a synthetic adapter context; never from HTTP input. */
  dataClassification?: "synthetic";
  structuredOutput?: {
    name: string;
    schema: Record<string, unknown>;
  };
}

export interface ModelResult {
  text: string;
  provider: string;
  model: string;
  /** Reported by providers that make a real model call. Absent for the deterministic mock. */
  usage?: ModelUsage;
}

export interface ModelProvider {
  readonly name: string;
  generate(request: ModelRequest): Promise<ModelResult>;
}

/**
 * Cumulative spending guard shared by every call a provider makes. `reserve` either
 * admits the worst-case cost of one attempt or throws; `settle` replaces a reservation
 * with what was actually used.
 */
export interface SpendingLimiter {
  reserve(usd: number): { settle(actualUsd: number): void };
  snapshot(): { limitUsd: number; spentUsd: number; windowStartedAt: string };
}
