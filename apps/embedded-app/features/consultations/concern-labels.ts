import type { RequestConcernKind } from "@/shared/contracts";
import { workEn } from "@/apps/embedded-app/i18n/work";

/** How each kind of challenge to a consultation request is named to the physician (English; the panel reads the dictionary of its language). */
export const CONCERN_LABELS: Record<RequestConcernKind, string> = workEn.concerns;
