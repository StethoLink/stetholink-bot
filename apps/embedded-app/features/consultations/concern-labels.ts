import type { RequestConcernKind } from "@/shared/contracts";

/** How each kind of challenge to a consultation request is named to the physician. */
export const CONCERN_LABELS: Record<RequestConcernKind, string> = {
  missing_specialty: "Specialty not named",
  specialty_fit: "Specialty may not fit this chart",
  unclear_question: "No clear question for the specialist",
  missing_information: "Key information is missing",
  conflicts_with_chart: "Request conflicts with the chart",
  urgency: "Possibly more urgent than requested",
};

