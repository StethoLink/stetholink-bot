import "server-only";
import { mockProvider } from "@/core/agent/providers/mock-provider";
import { createOpenAIProvider } from "@/core/agent/providers/openai-provider";
import { clinicalSafetyGuard } from "@/core/agent/safety/guard";
import { RouteError } from "@/core/errors";
import { createScribeService, type ScribeConfig } from "@/core/scribe/service";
import type { TranscriptionProvider } from "@/core/scribe/ports";
import { createElevenLabsTranscription } from "@/integrations/transcription/elevenlabs";
import { mockTranscription } from "@/integrations/transcription/mock";
import { createOpenAITranscription, type TranscriptionEvent } from "@/integrations/transcription/openai";
import { auditConsultation } from "@/platform/audit";
import type { VerifiedLaunch } from "@/platform/auth/identity";
import { createChartWriteLedger, createScribeRepository } from "@/platform/persistence/scribe";
import { getTenant } from "@/platform/tenants";
import { getEnv, scribeProblems } from "@/platform/tenants/env";
import { spendingLimiter } from "@/platform/tenants/model-provider";
import { getChartWriter } from "./chart-writer";
import { getClinicalServices, requireAssistantData } from "./index";

const globals = globalThis as typeof globalThis & { stetholinkScribeHints?: Map<string, readonly string[]> };
/** Metrics only. Audio, transcript text, note text and credentials are never logged. */
const observe = (event: TranscriptionEvent) => console.info(JSON.stringify({ action: "transcription.call", ...event, at: new Date().toISOString() }));

export function getTranscriptionProvider(): TranscriptionProvider {
  const env = getEnv();
  const budget = spendingLimiter("transcription");
  const shared = { model: env.TRANSCRIPTION_MODEL, usdPerMinute: env.TRANSCRIPTION_USD_PER_MINUTE, liveDataApproved: env.TRANSCRIPTION_LIVE_DATA_APPROVED === "true" };
  switch (env.TRANSCRIPTION_PROVIDER) {
    case "openai": return createOpenAITranscription({ ...shared, apiKey: env.OPENAI_API_KEY, baseUrl: env.TRANSCRIPTION_BASE_URL ?? env.OPENAI_BASE_URL, allowLoopbackHttp: env.NODE_ENV !== "production" }, fetch, { budget, observe });
    case "elevenlabs": return createElevenLabsTranscription({ ...shared, apiKey: env.ELEVENLABS_API_KEY }, fetch, { budget, observe });
    case "mock": return mockTranscription;
  }
}

/** The note model: its own, cheaper model setting, the same provider gate and cost bounds. One call per visit. */
function getNoteProvider() {
  const env = getEnv();
  if (env.AI_PROVIDER !== "openai") return mockProvider;
  return createOpenAIProvider({
    apiKey: env.OPENAI_API_KEY, model: env.SCRIBE_NOTE_MODEL, ...(env.OPENAI_BASE_URL ? { baseUrl: env.OPENAI_BASE_URL } : {}), allowLoopbackHttp: env.NODE_ENV !== "production",
    timeoutMs: env.OPENAI_TIMEOUT_MS, maxRetries: env.OPENAI_MAX_RETRIES, maxInputTokens: 120_000, maxOutputTokens: 12_000, maxCostUsd: Math.min(1, env.SCRIBE_MAX_VISIT_USD),
    reasoningEffort: env.SCRIBE_NOTE_REASONING_EFFORT,
    inputUsdPerMillion: env.SCRIBE_NOTE_INPUT_USD_PER_MILLION ?? env.OPENAI_INPUT_USD_PER_MILLION, outputUsdPerMillion: env.SCRIBE_NOTE_OUTPUT_USD_PER_MILLION ?? env.OPENAI_OUTPUT_USD_PER_MILLION,
    liveDataApproved: env.MODEL_LIVE_DATA_APPROVED === "true",
  }, fetch, { budget: spendingLimiter("model"), observe: (event) => console.info(JSON.stringify({ action: "model.call", ...event, at: new Date().toISOString() })) });
}

export function scribeConfig(): ScribeConfig {
  const env = getEnv();
  const problems = env.TRANSCRIPTION_PROVIDER === "mock" ? [] : scribeProblems(env).filter((problem) => !problem.includes("LIVE_DATA_APPROVED") || env.CLINICAL_DATA_MODE === "live");
  const reason = env.SCRIBE_ENABLED !== "true" ? "The scribe is not switched on for this hospital. Ask your StethoLink administrator."
    : !env.STETHOLINK_DATABASE_URL ? "The scribe needs the StethoLink database, which is not configured."
    : problems.length ? "The scribe is not fully configured. Tell your StethoLink administrator." : undefined;
  return {
    enabled: !reason, disabledReason: reason, spokenLanguage: env.SCRIBE_SPOKEN_LANGUAGE, noteLanguage: env.SCRIBE_NOTE_LANGUAGE, maxVisitMinutes: env.SCRIBE_MAX_VISIT_MINUTES,
    maxVisitUsd: env.SCRIBE_MAX_VISIT_USD, transcriptRetentionDays: env.SCRIBE_TRANSCRIPT_RETENTION_DAYS, chunkSeconds: 25,
  };
}

export function getScribe(session: VerifiedLaunch) {
  const actor = session.context;
  const tenant = getTenant();
  if (actor.tenantId !== tenant.id || !actor.encounterId || !actor.scopes.includes("chart:read")) throw new RouteError("forbidden", "An authorized tenant encounter is required");
  const { adapter } = getClinicalServices(session);
  requireAssistantData(session, adapter);
  const config = scribeConfig();
  const hints = globals.stetholinkScribeHints ??= new Map();
  const service = createScribeService({
    repository: createScribeRepository(actor), ledger: createChartWriteLedger(actor), transcription: getTranscriptionProvider(), noteProvider: getNoteProvider(),
    safety: clinicalSafetyGuard, adapter, writer: getChartWriter(session), dataClassification: actor.dataClassification, config,
    hints: { get: (id) => hints.get(id), set: (id, value) => { if (hints.size > 500) hints.clear(); hints.set(id, value); } },
    audit: auditConsultation,
  });
  return {
    capabilities: () => service.capabilities(actor),
    list: () => service.list(actor),
    get: (id: string) => service.get(actor, id),
    start: (input: Parameters<typeof service.start>[1]) => service.start(actor, input),
    addChunk: (id: string, chunk: Parameters<typeof service.addChunk>[2]) => service.addChunk(actor, id, chunk),
    generateNote: (id: string) => service.generateNote(actor, id),
    editNote: (id: string, input: Parameters<typeof service.editNote>[2]) => service.editNote(actor, id, input),
    relabel: (id: string, speakers: Parameters<typeof service.relabel>[2]) => service.relabel(actor, id, speakers),
    discard: (id: string) => service.discard(actor, id),
    approveAndWrite: (id: string, input: Parameters<typeof service.approveAndWrite>[2]) => service.approveAndWrite(actor, id, input),
  };
}
