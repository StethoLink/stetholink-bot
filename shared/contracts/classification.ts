import type { DATA_CLASSIFICATIONS } from "@/shared/constants";

/**
 * Whether clinical content concerns fictional test patients ("synthetic") or real patients
 * of a tenant configured for live clinical data ("live").
 *
 * The server derives it from the verified session and the tenant configuration. It is never
 * accepted from HTTP input, and a draft, envelope or callback must carry the same
 * classification as the session and tenant that handle it. The two are never mixed.
 */
export type DataClassification = (typeof DATA_CLASSIFICATIONS)[number];
