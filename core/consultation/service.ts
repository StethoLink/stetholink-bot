import type { ClinicianContext } from "@/core/auth/clinician";
import type { ApprovalRequest, ConsultationDraft, KnownClinicalFact, ConsultationGrounding, ConsultationRequest, CreateConsultationDraftRequest, ModelRevisionRequest, ModelUsage } from "@/shared/contracts";
import { consultationDraftSchema, consultationRequestSchema, createConsultationDraftRequestSchema, encounterContextSchema, patientContextSchema } from "@/shared/schemas";
import type { ConsultationRepository, DurableConsultationRepository } from "@/core/consultation/repository";
import type { ModelProvider } from "@/core/agent/providers/types";
import type { SafetyGuard } from "@/core/agent/safety/guard";
import type { ClinicalDataAdapter } from "@/core/tools/connector";
import { PROMPT_VERSION, SYSTEM_INSTRUCTIONS } from "@/core/agent/prompts/system";
import { RouteError } from "@/core/errors";
import { CONTEXT_VERSION, groundContext, renderFact, selectionFormat, validateSelection } from "./grounding";
import {
  AUTHORING_INSTRUCTIONS, AUTHORING_PROMPT_VERSION, MAX_AUTHORING_ATTEMPTS, buildAuthoringInput, referralFormat, renderReferral, validateReferral,
  type AuthoringContext, type ValidatedReferral,
} from "./authoring";
import { SUGGESTION_PREFIX } from "@/shared/utils/referral-text";

export interface ConsultationServiceDeps {
  repository: ConsultationRepository;
  provider: ModelProvider;
  safety: SafetyGuard;
  adapter: ClinicalDataAdapter;
  /** Specialties the tenant can route to; the model is asked to use these spellings. */
  specialties?: readonly string[];
}

function sumUsage(a: ModelUsage | null, b: ModelUsage | undefined): ModelUsage | null {
  if (!b) return a;
  if (!a) return b;
  return {
    inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
    estimatedCostUsd: a.estimatedCostUsd === null || b.estimatedCostUsd === null ? null : Number((a.estimatedCostUsd + b.estimatedCostUsd).toFixed(6)),
    latencyMs: a.latencyMs + b.latencyMs, attempts: a.attempts + b.attempts,
  };
}

export function createConsultationService(deps: ConsultationServiceDeps) {
  /** Reads and validates the synthetic chart for one request. Nothing outside the verified chart is loaded. */
  async function loadChart(input: { patientId: string; encounterId?: string }) {
    if (deps.adapter.source !== "synthetic") throw new RouteError("forbidden", "Only synthetic patient data is supported");
    const rawPatient = await deps.adapter.getPatient(input.patientId);
    if (!rawPatient) throw new RouteError("not_found", "Patient not found");
    const patientResult = patientContextSchema.safeParse(rawPatient);
    if (!patientResult.success) throw new RouteError("safety_blocked", "Invalid clinical patient context");
    const patient = patientResult.data;
    if (patient.source !== "synthetic") throw new RouteError("forbidden", "Only synthetic patient data is supported");
    if (patient.patientId !== input.patientId) throw new RouteError("safety_blocked", "Patient context mismatch");
    const rawEncounter = input.encounterId ? await deps.adapter.getEncounter(input.encounterId) : null;
    const encounterResult = rawEncounter ? encounterContextSchema.safeParse(rawEncounter) : null;
    if (encounterResult && !encounterResult.success) throw new RouteError("safety_blocked", "Invalid clinical encounter context");
    const encounter = encounterResult?.success ? encounterResult.data : null;
    if (input.encounterId && (!encounter || encounter.patientId !== patient.patientId || encounter.encounterId !== input.encounterId)) {
      throw new RouteError("invalid_request", "Encounter does not belong to this patient");
    }
    return { patient, encounter, grounded: groundContext(patient, encounter) };
  }

  /**
   * One or two model calls, each validated against the chart. A response is used only if it
   * passes; a failed first response is asked for again, never patched by hand.
   */
  async function askModel(context: AuthoringContext) {
    let usage: ModelUsage | null = null;
    let failure: unknown;
    for (let attempt = 0; attempt < MAX_AUTHORING_ATTEMPTS; attempt++) {
      const result = await deps.provider.generate({
        instructions: AUTHORING_INSTRUCTIONS,
        // Normalized facts, the physician's words and (for a revision) the current text. No demographics or identifiers.
        messages: [{ role: "user", content: buildAuthoringInput(context) }],
        dataClassification: "synthetic",
        structuredOutput: referralFormat,
      });
      usage = sumUsage(usage, result.usage);
      try {
        if (result.text.length > 32_000) throw new RouteError("provider_unavailable", "Model response exceeds the draft limit");
        return { referral: validateReferral(result.text, context), result, usage };
      } catch (error) {
        // A missing specialty is the physician's to fix; asking the model again would not help.
        if (error instanceof RouteError && error.code === "invalid_request") throw error;
        failure = error;
      }
    }
    throw failure;
  }

  function safetyNotes(grounded: ReturnType<typeof groundContext>) {
    const flags: ConsultationGrounding["safetyFlags"] = ["clinician_review_required"];
    const notes: string[] = [];
    if (grounded.conflicts.length) {
      flags.push("conflicting_facts");
      notes.push("Conflicting source assertions require clinician reconciliation; no assertion was chosen as true.");
    }
    if (!grounded.eligibleFacts.some((fact) => fact.category === "investigation") || grounded.missing.some((fact) => fact.category === "investigation")) {
      flags.push("missing_investigations");
      notes.push("Some investigation results are unknown; absence of results does not imply normal or unperformed tests.");
    }
    if (!grounded.eligibleFacts.length) {
      flags.push("insufficient_clinical_data");
      notes.push("No nonconflicting known normalized clinical facts are available; legacy lists are not interpreted as negative findings.");
    }
    return { flags, notes };
  }

  async function assertSafe(parts: string[]) {
    const safety = await deps.safety.assess(parts.join("\n"));
    if (safety.level === "blocked") throw new RouteError("safety_blocked", "Draft withheld by safety check");
  }

  /**
   * Model-authored draft from the physician's natural-language request. The model proposes;
   * only statements supported by their cited chart facts are kept. Cannot approve, persist or route.
   */
  async function author(chart: { patientId: string; encounterId?: string }, physicianRequest: string): Promise<ConsultationDraft> {
    const { encounter, grounded } = await loadChart(chart);
    const reasonForVisit = encounter?.reasonForVisit?.trim() || null;
    const context: AuthoringContext = {
      physicianRequest, reasonForVisit, availableSpecialties: deps.specialties ?? [],
      facts: grounded.facts, eligibleFacts: grounded.eligibleFacts, missing: grounded.missing,
    };
    const { referral, result, usage } = await askModel(context);
    const { flags, notes } = safetyNotes(grounded);
    const rendered = renderReferral(referral, context, notes);
    const grounding: ConsultationGrounding = {
      reason: reasonForVisit, question: referral.clinicalQuestion, specialty: referral.specialty,
      evidenceIds: referral.citedIds, gaps: [...grounded.missing.map(renderFact), ...notes], conflicts: grounded.conflicts, safetyFlags: flags,
      provenance: { provider: result.provider, model: result.model, promptVersion: AUTHORING_PROMPT_VERSION, contextVersion: CONTEXT_VERSION, dataClassification: "synthetic", encounterReference: encounter?.encounterId ?? null },
      authoring: { mode: "model_authored", physicianRequest, rejectedStatements: referral.rejectedStatements, liveInference: result.provider !== "mock", usage },
    };
    const now = new Date().toISOString();
    const draft = consultationDraftSchema.safeParse({
      id: crypto.randomUUID(), patientId: chart.patientId, encounterId: chart.encounterId,
      status: "pending_approval", generatedBy: "ai", createdAt: now, updatedAt: now, ...rendered,
      clinicalFacts: grounded.facts, missingInformation: grounded.missing, grounding,
    });
    if (!draft.success) throw new RouteError("provider_unavailable", "Draft could not be validated");
    await assertSafe([draft.data.summary, draft.data.assessment, ...draft.data.plan]);
    return draft.data;
  }

  /**
   * Model revision of an existing draft's wording. Works from the facts stored with the draft,
   * so sources cannot change; specialty and question are fixed. Returns text only.
   */
  async function reviseText(draft: ConsultationDraft, instruction: string) {
    const authoring = draft.grounding?.authoring;
    if (draft.grounding?.provenance.dataClassification !== "synthetic" || !authoring || !draft.grounding.specialty || !draft.grounding.question) {
      throw new RouteError("conflict", "Only a consultation drafted by the assistant can be revised by the assistant");
    }
    const facts = draft.clinicalFacts ?? [];
    const conflicting = new Set(draft.grounding.conflicts.flat());
    const context: AuthoringContext = {
      physicianRequest: authoring.physicianRequest, reasonForVisit: draft.grounding.reason, availableSpecialties: deps.specialties ?? [],
      facts, missing: draft.missingInformation ?? [],
      eligibleFacts: facts.filter((fact): fact is KnownClinicalFact => fact.status === "known" && !conflicting.has(fact.id)),
      revision: {
        instruction, specialty: draft.grounding.specialty, clinicalQuestion: draft.grounding.question, currentRequestText: draft.summary,
        currentSuggestions: draft.plan.filter((item) => item.startsWith(SUGGESTION_PREFIX)).map((item) => item.slice(SUGGESTION_PREFIX.length)),
      },
    };
    const { referral, result, usage } = await askModel(context);
    const rendered = renderReferral(referral, context, []);
    // The missing-information text is derived from the chart at creation and is not rewritten.
    const revised = { summary: rendered.summary, assessment: draft.assessment, plan: rendered.plan };
    await assertSafe([revised.summary, revised.assessment, ...revised.plan]);
    return { ...revised, referral: referral as ValidatedReferral, provider: result.provider, model: result.model, usage };
  }

  /** A preview cannot approve, persist or route anything. Intent is supplied by trusted composition. */
  async function preview(request: CreateConsultationDraftRequest, intent?: ConsultationRequest) {
    const inputResult = createConsultationDraftRequestSchema.safeParse(request);
    const intentResult = intent ? consultationRequestSchema.safeParse(intent) : undefined;
    if (!inputResult.success || (intentResult && !intentResult.success)) throw new RouteError("invalid_request", "Invalid draft request");
    const input = inputResult.data;
    const normalizedIntent = intentResult?.success ? intentResult.data : undefined;
    if (input.conversationId) throw new RouteError("invalid_request", "Conversation-based drafts are not supported yet; omit conversationId");
    if (normalizedIntent && (normalizedIntent.patientId !== input.patientId || normalizedIntent.encounterId !== input.encounterId)) {
      throw new RouteError("invalid_request", "Consultation intent does not match the requested context");
    }
    const { encounter, grounded } = await loadChart(input);
    const result = await deps.provider.generate({
      instructions: SYSTEM_INSTRUCTIONS,
      // No demographics, raw legacy lists, identity, free text intent, chat or attachments.
      // The structured schema limits output to a permutation of eligible source IDs.
      messages: [{ role: "user", content: JSON.stringify(grounded.context) }],
      dataClassification: "synthetic",
      structuredOutput: selectionFormat,
    });
    if (result.text.length > 16_000) throw new RouteError("provider_unavailable", "Model response exceeds the draft limit");
    const evidenceIds = validateSelection(result.text, grounded.eligibleFacts.map((fact) => fact.id));
    const safety = await deps.safety.assess(result.text);
    if (safety.level === "blocked") throw new RouteError("safety_blocked", "Draft withheld by safety check");
    const gaps = grounded.missing.map(renderFact);
    const safetyFlags: ConsultationGrounding["safetyFlags"] = ["clinician_review_required"];
    if (grounded.conflicts.length) {
      safetyFlags.push("conflicting_facts");
      gaps.push("Conflicting source assertions require clinician reconciliation; no assertion was chosen as true.");
    }
    if (!grounded.eligibleFacts.some((fact) => fact.category === "investigation") || grounded.missing.some((fact) => fact.category === "investigation")) {
      safetyFlags.push("missing_investigations");
      gaps.push("Investigation results are unknown; absence of results does not imply normal or unperformed tests.");
    }
    if (!grounded.eligibleFacts.length) {
      safetyFlags.push("insufficient_clinical_data");
      gaps.push("No nonconflicting known normalized clinical facts are available; legacy lists are not interpreted as negative findings.");
    }
    if (!normalizedIntent || !encounter?.reasonForVisit?.trim()) {
      safetyFlags.push("incomplete_referral");
      gaps.push("Verify the referral reason, clinical question, specialty and urgency before physician approval.");
    }
    const grounding: ConsultationGrounding = {
      reason: encounter?.reasonForVisit?.trim() || null,
      question: normalizedIntent?.clinicalQuestion ?? null,
      specialty: normalizedIntent?.specialty ?? null,
      evidenceIds, gaps, conflicts: grounded.conflicts, safetyFlags,
      provenance: { provider: result.provider, model: result.model, promptVersion: PROMPT_VERSION, contextVersion: CONTEXT_VERSION, dataClassification: "synthetic", encounterReference: encounter?.encounterId ?? null },
    };
    const evidence = evidenceIds.map((id) => renderFact(grounded.eligibleFacts.find((fact) => fact.id === id)!));
    const now = new Date().toISOString();
    const draft = consultationDraftSchema.safeParse({
      id: crypto.randomUUID(), patientId: input.patientId, encounterId: input.encounterId,
      status: "pending_approval", generatedBy: "ai", createdAt: now, updatedAt: now,
      summary: ["Synthetic consultation draft; physician review required.", `Reason: ${grounding.reason ?? "unknown (not provided)"}`, `Question: ${grounding.question ?? "unknown (not provided)"}`, `Specialty: ${grounding.specialty ?? "unknown (not provided)"}`, ...evidence].join("\n"),
      assessment: [`Safety flags: ${safetyFlags.join(", ")}`, ...grounded.conflicts.map((ids) => `Unresolved conflict: ${ids.join(", ")}`), `Provenance: ${result.provider}/${result.model}; ${PROMPT_VERSION}; ${CONTEXT_VERSION}`].join("\n"),
      plan: [...gaps, "Physician must verify the sources and decide whether to approve in the separate authenticated approval workflow."],
      clinicalFacts: grounded.facts, missingInformation: grounded.missing, grounding,
    });
    if (!draft.success) throw new RouteError("provider_unavailable", "Draft could not be validated");
    const renderedSafety = await deps.safety.assess([draft.data.summary, draft.data.assessment, ...draft.data.plan].join("\n"));
    if (renderedSafety.level === "blocked") throw new RouteError("safety_blocked", "Draft withheld by safety check");
    return draft.data;
  }
  return {
    get: deps.repository.get,
    async approve(input: ApprovalRequest, actor: ClinicianContext) {
      if (actor.authorization !== "active" || actor.expiresAt <= Date.now() ||
          !actor.roles.includes("physician") || !actor.scopes.includes("consultation:approve")) {
        throw new RouteError("forbidden", "Physician approval is required");
      }
      return deps.repository.approve(input);
    },
    preview,
    author,
    /**
     * Applies a physician's natural-language revision. The stored text changes only through the
     * normal lifecycle (reopen, revise, resubmit), so the result is again awaiting physician review
     * and no earlier approval survives. Never approves or sends.
     */
    async reviseWithModel(draftId: string, input: ModelRevisionRequest, actor: ClinicianContext, lifecycle: DurableConsultationRepository) {
      if (actor.authorization !== "active" || actor.expiresAt <= Date.now() || !actor.scopes.includes("consultation:draft")) {
        throw new RouteError("forbidden", "Draft access is required");
      }
      const draft = await lifecycle.get(draftId);
      if (!draft) throw new RouteError("not_found", "Draft not found");
      const status = draft.lifecycleStatus ?? draft.status;
      if (!["pending_review", "pending_approval", "draft"].includes(status)) throw new RouteError("conflict", "Only a consultation awaiting review can be revised");
      if (draft.version !== input.expectedVersion) throw new RouteError("conflict", "The consultation changed; reload it before asking for a revision");
      // Reopening is a physician decision on the reviewed version, recorded like any other.
      if (status !== "draft" && (!actor.roles.includes("physician") || !actor.scopes.includes("consultation:approve"))) {
        throw new RouteError("forbidden", "A physician must reopen the draft for changes");
      }
      const revised = await reviseText(draft, input.instruction);
      let version = input.expectedVersion;
      if (status !== "draft") {
        version = (await lifecycle.approve({ draftId, decision: "request_changes", expectedVersion: version, idempotencyKey: input.idempotencyKey + ":reopen" })).version ?? version + 1;
      }
      version = (await lifecycle.revise(draftId, { expectedVersion: version, idempotencyKey: input.idempotencyKey + ":revise", summary: revised.summary, assessment: revised.assessment, plan: revised.plan })).version ?? version + 1;
      const saved = await lifecycle.transition(draftId, { action: "submit", expectedVersion: version, idempotencyKey: input.idempotencyKey + ":submit" });
      return { draft: consultationDraftSchema.parse(saved), revision: { provider: revised.provider, model: revised.model, usage: revised.usage, rejectedStatements: revised.referral.rejectedStatements } };
    },
    async create(input: CreateConsultationDraftRequest, actor: ClinicianContext) {
      if (actor.authorization !== "active" || actor.expiresAt <= Date.now() || !actor.scopes.includes("consultation:draft") ||
          input.patientId !== actor.patientId || (input.encounterId !== undefined && input.encounterId !== actor.encounterId)) {
        throw new RouteError("forbidden", "Draft context does not match the active chart");
      }
      const chart = { patientId: actor.patientId, encounterId: actor.encounterId };
      if (input.request !== undefined) {
        const parsed = createConsultationDraftRequestSchema.safeParse({ ...chart, request: input.request });
        if (!parsed.success || !parsed.data.request || input.conversationId) throw new RouteError("invalid_request", "Describe the consultation you want prepared");
        // The physician's words go to the model with the verified chart's facts, and nothing else.
        const authored = await author(chart, parsed.data.request);
        const fields = { provider: authored.grounding!.provenance.provider, model: authored.grounding!.provenance.model, promptVersion: authored.grounding!.provenance.promptVersion };
        const stored = input.idempotencyKey
          ? await deps.repository.create(authored, actor.clinicianId, fields, { key: input.idempotencyKey, request: { ...chart, request: parsed.data.request } })
          : await deps.repository.create(authored, actor.clinicianId, fields);
        return consultationDraftSchema.parse(stored);
      }
      // Structured intent is bound to the verified chart; it is never model input.
      const intent = input.specialty !== undefined && input.clinicalQuestion !== undefined
        ? { ...chart, specialty: input.specialty, clinicalQuestion: input.clinicalQuestion } : undefined;
      const draft = await preview({ ...chart, conversationId: input.conversationId }, intent);
      const provenance = draft.grounding!.provenance;
      const provenanceFields = { provider: provenance.provider, model: provenance.model, promptVersion: provenance.promptVersion };
      const saved = input.idempotencyKey
        ? await deps.repository.create(draft, actor.clinicianId, provenanceFields, { key: input.idempotencyKey, request: intent ? { ...chart, specialty: intent.specialty, clinicalQuestion: intent.clinicalQuestion } : chart })
        : await deps.repository.create(draft, actor.clinicianId, provenanceFields);
      return consultationDraftSchema.parse(saved);
    },
  };
}
