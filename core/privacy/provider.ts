import type { ModelProvider } from "@/core/agent/providers/types";
import { RouteError } from "@/core/errors";
import type { ModelPrivacy, SurrogateVault } from "./ports";
import { createSurrogateState, hideDocuments, remainingIdentifiers, restoreDocument, type SurrogateState } from "./pseudonymizer";

/** Added to every instruction set, so the model keeps the stand-ins and day offsets exactly as written. Constant text: it holds nothing about any patient. */
export const PRIVACY_NOTE = [
  "Privacy rules for this request: names of people in the input are stand-ins, and identifiers appear as tokens such as ID-A, PHONE-A, EMAIL-A, URL-A or DATE-A.",
  "Calendar dates are written as day offsets from the day of the visit: T+0d is the visit day, T-3d is three days before it, T+7d is seven days after it; a time of day may follow.",
  "Copy stand-in names, tokens and day offsets exactly as written whenever you refer to them or quote text that contains them. Never translate, transliterate, reformat or expand them, and never guess what they replace.",
].join(" ");

/**
 * The de-identification layer around a model provider. Every message is de-identified before the
 * inner provider sees it and the answer is mapped back before the caller sees it, so callers work
 * with real chart text and the provider never receives it. Nothing is sent when the chart's
 * identifiers cannot be loaded or when one of them is still present after replacement.
 */
export function createPseudonymizingProvider(inner: ModelProvider, privacy: ModelPrivacy, vault: SurrogateVault<SurrogateState>): ModelProvider {
  return {
    name: inner.name,
    async generate(request) {
      let state: SurrogateState;
      let messages: string[];
      try {
        const identity = await privacy.identity();
        state = vault.open(privacy.sessionKey, privacy.expiresAt, () => createSurrogateState(identity.anchorDate));
        messages = hideDocuments(state, request.messages.map((message) => message.content), identity);
      } catch {
        // The cause may carry chart content; it is not passed on or logged.
        throw new RouteError("provider_unavailable", "Nothing was sent to the model because the patient's identifiers could not be removed from the request");
      }
      if (remainingIdentifiers(state, messages.join("\n"))) {
        throw new RouteError("provider_unavailable", "Nothing was sent to the model because a patient identifier was still present after de-identification");
      }
      const result = await inner.generate({
        ...request, pseudonymized: true, instructions: `${request.instructions}\n${PRIVACY_NOTE}`,
        messages: request.messages.map((message, index) => ({ role: message.role, content: messages[index] })),
      });
      return { ...result, text: restoreDocument(state, result.text) };
    },
  };
}
