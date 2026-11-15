import { z } from "zod";
import type { ScribeSelection, ScribeSpeaker, SoapSection } from "@/shared/contracts";
import { apiErrorSchema, scribeCapabilitiesSchema, scribeSessionListSchema, scribeSessionViewSchema } from "@/shared/schemas";
import { call, DeliveryError, describeFailure } from "@/apps/embedded-app/features/consultations/hooks/deliveryState";

const base = "/api/scribe";
const one = (id: string) => `${base}/sessions/${encodeURIComponent(id)}`;
const chunkResult = z.object({ index: z.number(), added: z.boolean(), sentences: z.number() });

export const scribeApi = {
  capabilities: () => call(scribeCapabilitiesSchema, base),
  list: () => call(scribeSessionListSchema, `${base}/sessions`),
  get: (id: string) => call(scribeSessionViewSchema, one(id)),
  start: (idempotencyKey: string) => call(scribeSessionViewSchema, `${base}/sessions`, { patientConsentConfirmed: true, idempotencyKey }),
  generate: (id: string, signal?: AbortSignal) => call(scribeSessionViewSchema, `${one(id)}/note`, {}, "POST", signal),
  edit: (id: string, expectedVersion: number, sections: Record<SoapSection, { id?: string; text: string }[]>) => call(scribeSessionViewSchema, `${one(id)}/note`, { expectedVersion, sections }, "PATCH"),
  relabel: (id: string, speakers: { id: string; speaker: ScribeSpeaker | null }[]) => call(scribeSessionViewSchema, `${one(id)}/speakers`, { speakers }, "PATCH"),
  approve: (id: string, expectedVersion: number, selection: ScribeSelection) => call(scribeSessionViewSchema, `${one(id)}/approval`, { expectedVersion, selection }),
  async discard(id: string) {
    const response = await fetch(one(id), { method: "DELETE", credentials: "same-origin" }).catch(() => { throw new DeliveryError("The server could not be reached. Check your connection and try again."); });
    if (!response.ok) throw new DeliveryError(describeFailure(response.status));
  },
  /** One part of the recording, sent as raw audio. The audio is not kept by the browser after a successful upload. */
  async uploadChunk(id: string, index: number, durationMs: number, audio: Blob) {
    const response = await fetch(`${one(id)}/chunks?index=${index}&durationMs=${Math.round(durationMs)}`, {
      method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": audio.type || "audio/webm" }, body: audio,
    }).catch(() => { throw new DeliveryError("The server could not be reached."); });
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = apiErrorSchema.safeParse(json);
      const failure = new DeliveryError(describeFailure(response.status, error.success ? error.data.error : undefined));
      // A refusal (limit reached, recording ended, session ended) will not succeed on a retry.
      (failure as DeliveryError & { final?: boolean }).final = response.status >= 400 && response.status < 500;
      throw failure;
    }
    return chunkResult.parse(json);
  },
};
