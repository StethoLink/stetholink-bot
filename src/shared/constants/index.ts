export const APP_NAME = "StethoLink";
export const API_VERSION = "v1";

export const MESSAGE_ROLES = ["clinician", "assistant", "system"] as const;
export const CONSULTATION_STATUSES = ["draft", "active", "completed", "archived"] as const;
export const SAFETY_LEVELS = ["ok", "caution", "blocked"] as const;
