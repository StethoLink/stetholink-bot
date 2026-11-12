import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAIProvider, type ModelCallEvent, type OpenAIProviderConfig } from "@/core/agent/providers/openai-provider";
import { createSpendingLimiter } from "@/core/agent/providers/spending";
import { referralFormat } from "@/core/consultation/authoring";
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
    expect(result).toMatchObject({ text: '{"evidenceIds":[]}', provider: "openai", model: config.model });
    // 100 input tokens at $1/M and 20 output tokens at $2/M, from the hypothetical test rates.
    expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, estimatedCostUsd: 0.00014, attempts: 1 });
    expect(result.usage!.latencyMs).toBeGreaterThanOrEqual(0);
    const [url, init] = request.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(init).toMatchObject({ redirect: "error", cache: "no-store", headers: { Authorization: "Bearer synthetic-test-key" } });
    expect(JSON.parse(init.body)).toMatchObject({ store: false, instructions: SYSTEM_INSTRUCTIONS, max_output_tokens: 2048, text: { format: { type: "json_schema", strict: true, schema: selectionFormat.schema } } });
  });

  it.each([{}, { inputUsdPerMillion: undefined }, { outputUsdPerMillion: undefined }, { maxRetries: 3 }, { timeoutMs: 0 }, { maxOutputTokens: 20000 }, { maxCostUsd: 2 }])("fails closed for missing credentials or invalid/unpriced configuration (%j)", async (override) => {
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
    for (const payload of ["sensitive non-JSON response", "x".repeat(256_001)]) {
      const request = vi.fn().mockResolvedValue(new Response(payload));
      await expect(createOpenAIProvider(config, request).generate(input)).rejects.toMatchObject({ code: "provider_unavailable" });
    }
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  describe("usage, spending limits and observability", () => {
    const referralInput: ModelRequest = { ...input, structuredOutput: referralFormat };

    it("runs only the allowlisted structured tasks", async () => {
      const request = vi.fn().mockResolvedValue(Response.json(envelope()));
      await expect(createOpenAIProvider(config, request).generate(referralInput)).resolves.toMatchObject({ provider: "openai" });
      expect(JSON.parse(request.mock.calls[0][1].body).text.format).toMatchObject({ name: "consultation_referral", strict: true });
      await expect(createOpenAIProvider(config, request).generate({ ...input, structuredOutput: { name: "free_chat", schema: {} } })).rejects.toMatchObject({ code: "forbidden" });
      expect(request).toHaveBeenCalledTimes(1);
    });

    it("sends a reasoning effort only when configured", async () => {
      const request = vi.fn().mockImplementation(async () => Response.json(envelope()));
      await createOpenAIProvider(config, request).generate(input);
      await createOpenAIProvider({ ...config, reasoningEffort: "low" }, request).generate(input);
      expect(JSON.parse(request.mock.calls[0][1].body).reasoning).toBeUndefined();
      expect(JSON.parse(request.mock.calls[1][1].body).reasoning).toEqual({ effort: "low" });
    });

    it("adds up attempts and latency across a retry", async () => {
      const request = vi.fn().mockResolvedValueOnce(new Response("", { status: 503 })).mockResolvedValueOnce(Response.json(envelope()));
      const result = await createOpenAIProvider(config, request).generate(input);
      expect(result.usage).toMatchObject({ attempts: 2, inputTokens: 100 });
      expect(result.usage!.latencyMs).toBeGreaterThanOrEqual(100);
    });

    it("settles the shared budget to actual use, keeps failed attempts reserved, and blocks at the limit before any request", async () => {
      const budget = createSpendingLimiter(0.01);
      const ok = vi.fn().mockImplementation(async () => Response.json(envelope()));
      await createOpenAIProvider(config, ok, { budget }).generate(input);
      expect(budget.snapshot().spentUsd).toBeCloseTo(0.00014, 6);
      const failing = vi.fn().mockImplementation(async () => new Response("", { status: 400 }));
      await expect(createOpenAIProvider(config, failing, { budget }).generate(input)).rejects.toMatchObject({ code: "provider_unavailable" });
      const afterFailure = budget.snapshot().spentUsd;
      expect(afterFailure).toBeGreaterThan(0.004);
      // Each attempt reserves about $0.0047 at these rates; the third cannot fit in $0.01.
      await expect(createOpenAIProvider(config, failing, { budget }).generate(input)).rejects.toMatchObject({ code: "provider_unavailable" });
      const blocked = vi.fn();
      const events: ModelCallEvent[] = [];
      await expect(createOpenAIProvider(config, blocked, { budget, observe: (event) => events.push(event) }).generate(input)).rejects.toMatchObject({ code: "provider_unavailable" });
      expect(blocked).not.toHaveBeenCalled();
      expect(events).toEqual([expect.objectContaining({ outcome: "error", reason: "budget_limit", attempts: 0 })]);
    });

    it("reports metrics and reason codes, never prompts, outputs, keys or provider bodies", async () => {
      const events: ModelCallEvent[] = [];
      const observe = (event: ModelCallEvent) => events.push(event);
      await createOpenAIProvider(config, vi.fn().mockResolvedValue(Response.json(envelope())), { observe }).generate(input);
      await expect(createOpenAIProvider(config, vi.fn().mockResolvedValue(new Response("sensitive provider body", { status: 401 })), { observe }).generate(input)).rejects.toBeTruthy();
      await expect(createOpenAIProvider({ ...config, timeoutMs: 10 }, vi.fn().mockImplementation(() => new Promise(() => {})), { observe }).generate(input)).rejects.toBeTruthy();
      await expect(createOpenAIProvider(config, vi.fn().mockRejectedValue(new Error("sensitive transport detail")), { observe }).generate(input)).rejects.toBeTruthy();
      await expect(createOpenAIProvider(config, vi.fn().mockResolvedValue(Response.json({ ...envelope(), status: "incomplete" })), { observe }).generate(input)).rejects.toBeTruthy();
      expect(events.map((event) => [event.outcome, event.reason, event.httpStatus])).toEqual([
        ["ok", undefined, undefined], ["error", "http_error", 401], ["error", "timeout", undefined], ["error", "network_error", undefined], ["error", "invalid_response", undefined],
      ]);
      expect(events[0]).toMatchObject({ task: "consultation_evidence_selection", inputTokens: 100, outputTokens: 20, estimatedCostUsd: 0.00014 });
      const logged = JSON.stringify(events);
      for (const secret of ["synthetic-test-key", "sensitive", "evidenceIds", SYSTEM_INSTRUCTIONS]) expect(logged).not.toContain(secret);
    });
  });
});

describe("spending limiter", () => {
  it("admits reservations up to the limit, settles to actual cost and resets with the window", () => {
    let now = Date.UTC(2026, 0, 1, 12);
    const limiter = createSpendingLimiter(1, { now: () => now });
    const first = limiter.reserve(0.6);
    expect(() => limiter.reserve(0.5)).toThrow();
    first.settle(0.1);
    first.settle(0.9);
    expect(limiter.snapshot().spentUsd).toBeCloseTo(0.1);
    limiter.reserve(0.9);
    expect(() => limiter.reserve(0.01)).toThrow();
    expect(() => limiter.reserve(Number.NaN)).toThrow();
    now += 86_400_000;
    expect(limiter.snapshot()).toMatchObject({ spentUsd: 0, limitUsd: 1 });
    expect(() => limiter.reserve(1)).not.toThrow();
  });
});
