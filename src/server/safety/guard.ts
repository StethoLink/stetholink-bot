import type { SafetyGuard } from "@/shared/contracts";

/** Placeholder guard: always "ok". Replace with real policy checks. */
export const safetyGuard: SafetyGuard = {
  async assess() {
    return { level: "ok", reasons: [] };
  },
};
