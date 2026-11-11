import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAIProvider, type OpenAIProviderConfig } from "@/core/agent/providers/openai-provider";
import type { ModelRequest } from "@/core/agent/providers/types";
import { selectionFormat } from "@/core/consultation/grounding";
import { SYSTEM_INSTRUCTIONS } from "@/core/agent/prompts/system";

// Synthetic transport credentials and hypothetical prices; these are not API calls or model prices.
const config: OpenAIProviderConfig = { apiKey: "synthetic-test-key", model: "synthetic-test-model", inputUsdPerMillion: 1, outputUsdPerMillion: 2, maxRetries: 1 };
const input: ModelRequest = { instructions: SYSTEM_INSTRUCTIONS, messages: [{ role: "user", content: '{"facts":[],"eligibleEvidenceIds":[]}' }], dataClassification: "synthetic", structuredOutput: selectionFormat };
const envelope = () => ({ status: "completed", model: config.model, output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: '{"evidenceIds":[]}' }] }], usage: { input_tokens: 100, output_tokens: 20 } });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("server-side OpenAI structured synthetic provider (fake transport)", () => {
  it("uses strict Responses structured output, bounded tokens and no response storage", async () => {
    const request = vi.fn().mockResolvedValue(Response.json(envelope()));
    const result = await createOpenAIProvider(config, request).generate(input);
    expect(result).toEqual({ text: '{"evidenceIds":[]}', provider: "openai", model: config.model });
    const [url, init] = request.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(init).toMatchObject({ redirect: "error", cache: "no-store", headers: { Authorization: "Bearer synthetic-test-key" } });
    expect(JSON.parse(init.body)).toMatchObject({ store: false, instructions: SYSTEM_INSTRUCTIONS, max_output_tokens: 2048, text: { format: { type: "json_schema", strict: true, schema: selectionFormat.schema } } });
  });

  it.each([{}, { inputUsdPerMillion: undefined }, { outputUsdPerMillion: undefined }, { maxRetries: 3 }, { timeoutMs: 0 }, { maxOutputTokens: 10000 }, { maxCostUsd: 2 }])("fails closed for missing credentials or invalid/unpriced configuration (%j)", async (override) => {
    const settings = Object.keys(override).length ? { ...config, ...override } : { ...config, apiKey: undefined };
    const request = vi.fn();
    await expect(createOpenAIProvider(settings, request).generate(input)).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(request).not.toHaveBeenCalled();
  });

  it("denies unclassified data and unstructured chat before any network request", async () => {
    const request = vi.fn();
    for (const value of [{ ...input, dataClassification: undefined }, { ...input, structuredOutput: undefined }]) {
      await expect(createOpenAIProvider(config, request).generate(value)).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(request).not.toHaveBeenCalled();
  });

  it.each([429, 500, 502, 503, 504])("retries transient HTTP %s within a shared deadline", async (status) => {
    const request = vi.fn().mockResolvedValueOnce(new Response("sensitive provider body", { status })).mockResolvedValueOnce(Response.json(envelope()));
    await expect(createOpenAIProvider(config, request).generate(input)).resolves.toMatchObject({ provider: "openai" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403])("never retries permanent HTTP %s or leaks its body", async (status) => {
    const request = vi.fn().mockResolvedValue(new Response("sensitive provider body", { status }));
    await expect(createOpenAIProvider(config, request).generate(input)).rejects.toMatchObject({ code: "provider_unavailable", message: "OpenAI could not generate a validated response within configured limits" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("caps attempts and avoids automatic retries on ambiguous network errors", async () => {
    const request = vi.fn().mockImplementation(async () => new Response("", { status: 503 }));
    await expect(createOpenAIProvider({ ...config, maxRetries: 2 }, request).generate(input)).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(request).toHaveBeenCalledTimes(3);
    const network = vi.fn().mockRejectedValue(new Error("sensitive transport detail"));
    await expect(createOpenAIProvider(config, network).generate(input)).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized input and insufficient cost budget before network access", async () => {
    for (const limits of [{ maxInputTokens: 1 }, { maxCostUsd: 0.000001 }]) {
      const request = vi.fn();
      await expect(createOpenAIProvider({ ...config, ...limits }, request).generate(input)).rejects.toMatchObject({ code: "provider_unavailable" });
      expect(request).not.toHaveBeenCalled();
    }
  });

  it("charges the cost reservation for failed attempts and blocks an unaffordable retry", async () => {
    const request = vi.fn().mockImplementation(async () => new Response("", { status: 429 }));
    // Output alone reserves $0.004096; this permits one attempt, never two.
    await expect(createOpenAIProvider({ ...config, maxCostUsd: 0.008 }, request).generate(input)).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("aborts a stalled request even if a transport ignores the signal", async () => {
    const request = vi.fn().mockImplementation(() => new Promise(() => {}));
    await expect(createOpenAIProvider({ ...config, timeoutMs: 10 }, request).generate(input)).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(request.mock.calls[0][1].signal.aborted).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("includes response-body reading and retry backoff in the same timeout", async () => {
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"status":')); } });
    const request = vi.fn().mockResolvedValue(new Response(body));
    await expect(createOpenAIProvider({ ...config, timeoutMs: 10 }, request).generate(input)).rejects.toMatchObject({ code: "provider_unavailable" });
    const transient = vi.fn().mockImplementation(async () => new Response("", { status: 503 }));
    await expect(createOpenAIProvider({ ...config, timeoutMs: 10 }, transient).generate(input)).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(transient).toHaveBeenCalledTimes(1);
  });

  it.each([
    () => ({}),
    () => ({ ...envelope(), status: "incomplete" }),
    () => ({ ...envelope(), output: [] }),
    () => ({ ...envelope(), output: [{ type: "function_call" }] }),
    () => ({ ...envelope(), output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "sensitive refusal" }] }] }),
    () => ({ ...envelope(), output: [...envelope().output, ...envelope().output] }),
    () => ({ ...envelope(), usage: undefined }),
    () => ({ ...envelope(), usage: { input_tokens: 999999, output_tokens: 20 } }),
    () => ({ ...envelope(), usage: { input_tokens: 100, output_tokens: 2049 } }),
  ])("rejects malformed, refused, incomplete, ambiguous or over-budget responses (%#)", async (data) => {
    const request = vi.fn().mockResolvedValue(Response.json(data()));
    await expect(createOpenAIProvider(config, request).generate(input)).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid JSON and bounded response overflow without logging payloads", async () => {
    const log = vi.spyOn(console, "log");
    const error = vi.spyOn(console, "error");
    for (const payload of ["sensitive non-JSON response", "x".repeat(64_001)]) {
      const request = vi.fn().mockResolvedValue(new Response(payload));
      await expect(createOpenAIProvider(config, request).generate(input)).rejects.toMatchObject({ code: "provider_unavailable" });
    }
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
