import type { SafetyAssessment } from "@/shared/contracts";

export interface SafetyGuard {
  assess(text: string): Promise<SafetyAssessment>;
}

/** Structural checks and conservative rules for synthetic output. */
export const syntheticSafetyGuard: SafetyGuard = {
  async assess(text) {
    const hasUnsafeCharacters = Array.from(text).some((char) => {
      const point = char.charCodeAt(0);
      return (point < 32 && ![9, 10, 13].includes(point)) || (point >= 0x202a && point <= 0x202e) ||
        (point >= 0x2066 && point <= 0x2069);
    });
    if (!text.trim() || text.length > 32_000 || hasUnsafeCharacters || /<\/?[a-z][^>]*>|\b(?:javascript|data):/iu.test(text)) {
      return { level: "blocked", reasons: ["Unsafe output format"] };
    }
    if (/\b(?:consultation (?:was |is )?(?:approved|sent)|approved by (?:the )?(?:physician|clinician)|you should (?:start|stop|increase|decrease) taking)\b/iu.test(text)) {
      return { level: "blocked", reasons: ["Output asserted an approval, delivery or treatment instruction"] };
    }
    return { level: "ok", reasons: [] };
  },
};
