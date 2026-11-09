import type { SafetyAssessment } from "@/shared/contracts";

export interface SafetyGuard {
  assess(text: string): Promise<SafetyAssessment>;
}

/** Placeholder: approves everything. Codex replaces this with real output policy checks. */
export const passthroughSafetyGuard: SafetyGuard = {
  async assess() {
    return { level: "ok", reasons: [] };
  },
};
