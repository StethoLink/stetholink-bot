import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

export const CALLBACK_HEADERS = { provider: "x-stetholink-provider", timestamp: "x-stetholink-timestamp", signature: "x-stetholink-signature" } as const;
export const CALLBACK_MAX_BYTES = 65_536;
const MAX_SKEW_MS = 5 * 60_000;

/** HMAC-SHA256 over "<timestamp>.<raw body>", hex encoded. */
export function signProviderCallback(secret: string, timestamp: string, rawBody: string) {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

/**
 * Authenticates the sender of a callback. Returns the verified provider id or undefined;
 * every failure looks the same to the caller. The secret is looked up server-side.
 */
export function verifyProviderCallback(headers: Headers, rawBody: string, secretFor: (providerId: string) => string | undefined, now = Date.now()) {
  const providerId = headers.get(CALLBACK_HEADERS.provider) ?? "";
  const timestamp = headers.get(CALLBACK_HEADERS.timestamp) ?? "";
  const signature = headers.get(CALLBACK_HEADERS.signature) ?? "";
  const secret = providerId && providerId.length <= 128 ? secretFor(providerId) : undefined;
  const sentAt = /^\d{10,16}$/.test(timestamp) ? Number(timestamp) : NaN;
  // Compare against a keyed digest even when the provider is unknown, to keep timing uniform.
  const expected = Buffer.from(signProviderCallback(secret ?? "unknown-provider", timestamp, rawBody), "hex");
  const supplied = /^[0-9a-f]{64}$/.test(signature) ? Buffer.from(signature, "hex") : Buffer.alloc(32);
  const matches = timingSafeEqual(expected, supplied);
  if (!secret || !matches || !Number.isFinite(sentAt) || Math.abs(now - sentAt) > MAX_SKEW_MS) return undefined;
  return providerId;
}
