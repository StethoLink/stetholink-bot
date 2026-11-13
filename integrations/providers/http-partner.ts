import { createHmac } from "node:crypto";
import { z } from "zod";
import { ProviderTransportError, type ProviderAdapter } from "@/core/routing/ports";
import { consultationEnvelopeSchema, providerCallbackSchema } from "@/shared/schemas";

/**
 * Reference adapter for a provider that implements StethoLink provider contract 1.0 over HTTPS.
 * It is NOT connected to any provider: no real endpoint, credential or agreement exists in this
 * repository. The envelope carries the data classification of the session that sends it. A provider with its own API
 * gets its own adapter implementing the same interface.
 *
 * Request:  POST <endpoint>  body = the envelope JSON
 *           Idempotency-Key: <requestId>
 *           X-StethoLink-Timestamp: <ms>   X-StethoLink-Signature: hex HMAC-SHA256("<ms>.<body>")
 * Response: 200/202 {"requestId": "<same id>", "providerReference": "<provider's id>"}
 * Status:   GET <endpoint>/<requestId>/events -> {"events": [ProviderCallback, ...]}   (optional polling)
 */
export interface HttpPartnerConfig {
  providerId: string;
  /** HTTPS only. Loopback HTTP is accepted for local conformance tests. */
  endpoint: string;
  /** Server-side shared secret, at least 32 characters. Never sent; used only to sign. */
  secret: string;
  timeoutMs?: number;
}

const ackSchema = z.object({ requestId: z.uuid(), providerReference: z.string().min(1).max(256) });
const eventsSchema = z.object({ events: z.array(z.unknown()).max(50) });
const MAX_RESPONSE_BYTES = 262_144;

export function createHttpPartnerAdapter(config: HttpPartnerConfig, request: typeof fetch = fetch): ProviderAdapter {
  const endpoint = new URL(config.endpoint);
  const loopback = ["127.0.0.1", "localhost"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !(loopback && endpoint.protocol === "http:")) throw new Error("Provider endpoint must use HTTPS");
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("Provider endpoint must not carry credentials or parameters");
  if (config.secret.length < 32) throw new Error("Provider secret is too short");
  const timeoutMs = config.timeoutMs ?? 10_000;

  async function exchange(url: URL, init: { method: "GET" | "POST"; body?: string; idempotencyKey?: string }) {
    const timestamp = String(Date.now());
    const signature = createHmac("sha256", config.secret).update(`${timestamp}.${init.body ?? url.pathname}`).digest("hex");
    let response: Response;
    try {
      response = await request(url, {
        method: init.method, body: init.body, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Accept: "application/json", "X-StethoLink-Provider": config.providerId, "X-StethoLink-Timestamp": timestamp, "X-StethoLink-Signature": signature,
          ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.idempotencyKey ? { "Idempotency-Key": init.idempotencyKey } : {}),
        },
      });
    } catch (error) {
      throw new ProviderTransportError(error instanceof Error && error.name === "TimeoutError" ? "transport_timeout" : "transport_error", "Provider could not be reached");
    }
    if (!response.ok) {
      await response.body?.cancel();
      // The status is all that is kept; a provider's error body is never logged or shown.
      throw new ProviderTransportError("transport_error", `Provider answered ${response.status}`);
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new ProviderTransportError("invalid_acknowledgement", "Provider response is too large");
    try { return JSON.parse(text) as unknown; }
    catch { throw new ProviderTransportError("invalid_acknowledgement", "Provider response is not JSON"); }
  }

  return {
    kind: "partner_api",
    formats: ["stetholink.envelope.v1"],
    async send(envelope) {
      const outgoing = consultationEnvelopeSchema.safeParse(envelope);
      if (!outgoing.success || outgoing.data.providerId !== config.providerId) throw new ProviderTransportError("transport_error", "Envelope is not addressed to this provider");
      const ack = ackSchema.safeParse(await exchange(endpoint, { method: "POST", body: JSON.stringify(outgoing.data), idempotencyKey: outgoing.data.requestId }));
      if (!ack.success || ack.data.requestId !== outgoing.data.requestId) throw new ProviderTransportError("invalid_acknowledgement", "Provider acknowledged a different request");
      return ack.data;
    },
    async poll({ requestId }) {
      const url = new URL(`${endpoint.pathname.replace(/\/$/, "")}/${encodeURIComponent(requestId)}/events`, endpoint);
      const body = eventsSchema.safeParse(await exchange(url, { method: "GET" }));
      if (!body.success) throw new ProviderTransportError("invalid_acknowledgement", "Provider status is not in the agreed format");
      return body.data.events.map((event) => this.normalize!(event)).filter((event) => event.requestId === requestId);
    },
    normalize(raw) {
      const callback = providerCallbackSchema.safeParse(raw);
      // Contract 1.0 is already the normalized form; anything else is refused, never repaired.
      if (!callback.success || callback.data.providerId !== config.providerId) throw new ProviderTransportError("invalid_acknowledgement", "Provider message is not in the agreed format");
      return callback.data;
    },
  };
}
