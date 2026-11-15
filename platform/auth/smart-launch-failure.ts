import "server-only";
import { randomBytes } from "node:crypto";
import { AuthError } from "./session";

/**
 * Why a SMART launch stopped. One stable code per failure branch, written to the server log with the
 * correlation ID the clinician sees on the error page. The browser gets the same generic message for
 * every security failure; the code is for the administrator reading the log.
 */
export const SMART_LAUNCH_REASONS = [
  // Launch request (the EHR opens /api/smart/launch).
  "launch_malformed", "not_configured", "registration_invalid", "issuer_unregistered",
  "discovery_unreachable", "discovery_rejected", "discovery_invalid", "discovery_endpoint_mismatch", "pkce_s256_unsupported",
  // Callback request (the EHR returns to /api/smart/callback).
  "authorization_denied", "callback_malformed", "launch_session_missing",
  "callback_invalid", "token_endpoint_unreachable", "token_exchange_rejected", "grant_invalid",
  "id_token_missing", "identity_scopes_missing",
  "jwks_unavailable", "jwks_no_matching_key", "id_token_invalid", "binding_failed",
  "missing_patient", "clinician_unmapped", "clinician_not_practitioner", "clinician_reference_invalid", "missing_encounter",
  "fhir_patient_unreadable", "fhir_encounter_unreadable", "encounter_unsupported", "grant_expired",
  "unexpected",
] as const;
export type SmartLaunchReason = (typeof SMART_LAUNCH_REASONS)[number];

/**
 * A detail is a fixed word, optionally with one fixed word or an HTTP status after a colon
 * (`claim:iss`, `http:403`, `fhir_user:absolute_on_issuer`). It is never a value taken from a token,
 * a URL or the chart: anything that does not fit this shape is dropped before logging.
 */
const DETAIL = /^[a-z_]{1,24}(?::[a-z_0-9]{1,32})?$/;

export const GENERIC_LAUNCH_MESSAGE = "SMART clinician or chart context could not be verified";

export class SmartLaunchFailure extends Error {
  readonly reason: SmartLaunchReason;
  readonly detail?: string;
  /** What the browser is told. Defaults to the generic refusal. */
  readonly surfaced: Error;
  constructor(reason: SmartLaunchReason, detail?: string, surfaced: Error = new AuthError("forbidden", GENERIC_LAUNCH_MESSAGE)) {
    super(reason);
    this.name = "SmartLaunchFailure";
    this.reason = reason;
    this.detail = detail;
    this.surfaced = surfaced;
  }
}

/** Short enough to read aloud, random enough to find one line in a day of logs. Carries no information. */
export function newCorrelationId() {
  return randomBytes(6).toString("hex").toUpperCase().replace(/(.{4})(?=.)/g, "$1-");
}

/**
 * The only log line a failed launch writes. Its fields are closed: a reason from the list above, an
 * optional detail of the fixed shape, the correlation ID and the time. No token, code, state, nonce,
 * subject, `fhirUser`, patient or encounter identifier, URL or OAuth parameter can be passed in.
 */
export function logSmartLaunchFailure(stage: "launch" | "callback", reason: SmartLaunchReason, correlationId: string, detail?: string) {
  console.warn(JSON.stringify({
    action: "smart.launch_failed", stage,
    reason: SMART_LAUNCH_REASONS.includes(reason) ? reason : "unexpected",
    ...(detail && DETAIL.test(detail) ? { detail } : {}),
    correlationId: /^[0-9A-F-]{1,20}$/.test(correlationId) ? correlationId : "invalid",
    at: new Date().toISOString(),
  }));
}

/** Runs one launch step. A failure is logged once with its reason, then the browser-facing error is thrown. */
export async function observeSmartLaunch<T>(stage: "launch" | "callback", correlationId: string, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (error instanceof SmartLaunchFailure) {
      logSmartLaunchFailure(stage, error.reason, correlationId, error.detail);
      throw error.surfaced;
    }
    logSmartLaunchFailure(stage, "unexpected", correlationId);
    throw error;
  }
}
