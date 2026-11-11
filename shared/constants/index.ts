export const APP_NAME = "StethoLink";
export const CONTRACT_VERSION = "1.1.0";

export const CONSULTATION_STATUSES = [
  "draft",
  "pending_approval", // Compatibility alias for pending_review.
  "pending_review",
  "queued",
  "sent",
  "accepted",
  "responded",
  "failed",
  "cancelled",
  "approved",
  "rejected",
  "archived",
] as const;
export const APPROVAL_DECISIONS = ["approve", "reject", "request_changes"] as const;
export const MESSAGE_ROLES = ["clinician", "assistant", "system"] as const;
export const SAFETY_LEVELS = ["ok", "caution", "blocked"] as const;
export const ENCOUNTER_TYPES = ["inpatient", "outpatient", "emergency", "virtual"] as const;
export const ENCOUNTER_STATUSES = ["planned", "in_progress", "finished", "cancelled"] as const;
export const ADMINISTRATIVE_SEXES = ["male", "female", "other", "unknown"] as const;
export const DATA_SOURCES = ["synthetic", "fhir", "ehr"] as const;
export const API_ERROR_CODES = [
  "invalid_request",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "safety_blocked",
  "provider_unavailable",
  "not_implemented",
  "internal_error",
] as const;
