import type { ClinicianContext } from "@/core/auth/clinician";
import type { ApprovalRequest, ConsultationGrounding, ConsultationRequest, CreateConsultationDraftRequest } from "@/shared/contracts";
import { consultationDraftSchema, consultationRequestSchema, createConsultationDraftRequestSchema, encounterContextSchema, patientContextSchema } from "@/shared/schemas";
import type { ConsultationRepository } from "@/core/consultation/repository";
import type { ModelProvider } from "@/core/agent/providers/types";
import type { SafetyGuard } from "@/core/agent/safety/guard";
import type { ClinicalDataAdapter } from "@/core/tools/connector";
import { PROMPT_VERSION, SYSTEM_INSTRUCTIONS } from "@/core/agent/prompts/system";
import { RouteError } from "@/core/errors";
import { CONTEXT_VERSION, groundContext, renderFact, selectionFormat, validateSelection } from "./grounding";

export function createConsultationService(deps: { repository: ConsultationRepository; provider: ModelProvider; safety: SafetyGuard; adapter: ClinicalDataAdapter }) {
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
    const grounded = groundContext(patient, encounter);
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
      provenance: { provider: result.provider, model: result.model, promptVersion: PROMPT_VERSION, contextVersion: CONTEXT_VERSION, syntheticOnly: true, encounterReference: encounter?.encounterId ?? null },
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
    async create(input: CreateConsultationDraftRequest, actor: ClinicianContext) {
      if (actor.authorization !== "active" || actor.expiresAt <= Date.now() || !actor.scopes.includes("consultation:draft") ||
          input.patientId !== actor.patientId || (input.encounterId !== undefined && input.encounterId !== actor.encounterId)) {
        throw new RouteError("forbidden", "Draft context does not match the active chart");
      }
      const draft = await preview({ ...input, patientId: actor.patientId, encounterId: actor.encounterId });
      const provenance = draft.grounding!.provenance;
      // Existing persistence stores the grounded prose and source citations. Typed M2
      // metadata is preview/create output only until the persistence owner adds storage.
      const saved = await deps.repository.create(draft, actor.clinicianId, { provider: provenance.provider, model: provenance.model, promptVersion: provenance.promptVersion });
      return consultationDraftSchema.parse({ ...saved, clinicalFacts: draft.clinicalFacts, missingInformation: draft.missingInformation, grounding: draft.grounding });
    },
  };
}
