import type { ClinicianContext } from "@/core/auth/clinician";
import type { ModelProvider } from "@/core/agent/providers/types";
import type { SafetyGuard } from "@/core/agent/safety/guard";
import { groundContext } from "@/core/consultation/grounding";
import { patientDemographics } from "@/core/consultation/demographics";
import { RouteError } from "@/core/errors";
import { RESOURCE_OF, type ChartWriteItem, type ClinicalWriteAdapter } from "@/core/tools/chart-writer";
import type { ClinicalDataAdapter } from "@/core/tools/connector";
import type {
  ChartWriteResult, DataClassification, NoteLanguage, NoteStatement, ScribeApproval, ScribeCapabilities, ScribeNote, ScribeSessionView, ScribeSpeaker, SoapSection,
} from "@/shared/contracts";
import { SOAP_SECTIONS } from "@/shared/contracts";
import { classificationOfSource, patientContextSchema } from "@/shared/schemas";
import { generateScribeNote } from "./generate";
import { renderNoteText } from "./note";
import type { TranscriptionProvider } from "./ports";
import type { ChartWriteLedger, ScribeRepository } from "./repository";
import { toSentences } from "./segments";

export const CONSENT_STATEMENT = "The clinician confirmed that the patient agreed verbally to this visit being recorded for the clinical note.";
export const MAX_CHUNK_BYTES = 2_000_000;
export const MAX_CHUNK_SECONDS = 60;
const AUDIO_TYPES = /^audio\/(webm|ogg|mp4|wav|mpeg)(;.*)?$/i;

export interface ScribeConfig {
  enabled: boolean;
  /** Why it is off, for the clinician. */
  disabledReason?: string;
  spokenLanguage: string;
  noteLanguage: NoteLanguage;
  maxVisitMinutes: number;
  maxVisitUsd: number;
  transcriptRetentionDays: number;
  chunkSeconds: number;
}
export interface ScribeServiceDeps {
  repository: ScribeRepository;
  ledger: ChartWriteLedger;
  transcription: TranscriptionProvider;
  noteProvider: ModelProvider;
  safety: SafetyGuard;
  adapter: ClinicalDataAdapter;
  /** Null when this session may not write to an EHR (synthetic data, write-back off). Items then fall back to "copy to chart". */
  writer: ClinicalWriteAdapter | null;
  /** Classification of the verified session this service acts for. */
  dataClassification: DataClassification;
  config: ScribeConfig;
  /** Chart terms that help recognition, remembered for the length of a visit. */
  hints?: { get(sessionId: string): readonly string[] | undefined; set(sessionId: string, hints: readonly string[]): void };
  audit?(event: { action: "scribe.chart_write"; tenantId: string; clinicianId: string; sessionId: string; itemKey: string; resourceType: string; status: string; resourceId?: string }): void;
}

const itemKey = (sessionId: string, item: string) => `sl-${sessionId.replaceAll("-", "")}-${item}`;

export function createScribeService(deps: ScribeServiceDeps) {
  const classification = deps.dataClassification;
  const { config } = deps;

  function requireActor(actor: ClinicianContext, physician = false) {
    if (actor.authorization !== "active" || actor.expiresAt <= Date.now() || actor.dataClassification !== classification || !actor.encounterId || !actor.scopes.includes("scribe:record")) {
      throw new RouteError("forbidden", "Recording needs an active chart session");
    }
    if (physician && (!actor.roles.includes("physician") || !actor.scopes.includes("chart:write"))) {
      throw new RouteError("forbidden", "Only the physician can approve the note and write it to the chart");
    }
    if (!config.enabled) throw new RouteError("not_implemented", config.disabledReason ?? "The scribe is not switched on for this hospital");
  }
  async function chart(actor: ClinicianContext) {
    if (classificationOfSource(deps.adapter.source) !== classification) throw new RouteError("forbidden", "Clinical data does not belong to this session's data classification");
    const raw = await deps.adapter.getPatient(actor.patientId);
    const parsed = raw ? patientContextSchema.safeParse(raw) : undefined;
    if (!parsed?.success || parsed.data.patientId !== actor.patientId) throw new RouteError("not_found", "Patient not found");
    return { patient: parsed.data, grounded: groundContext(parsed.data, null, classification) };
  }
  async function load(id: string) {
    const stored = await deps.repository.get(id);
    if (!stored) throw new RouteError("not_found", "Visit not found");
    return stored;
  }

  /** What each approved item would create, built only from the stored note and the physician's selection. */
  function plannedItems(sessionId: string, note: ScribeNote, approval: ScribeApproval) {
    const confirmedAllergies = approval.selection.confirmedAllergies ?? [];
    const items: { item: string; write: ChartWriteItem; copyText: string }[] = [];
    if (approval.selection.note) {
      const text = renderNoteText(note.sections, note.language);
      items.push({ item: "note", copyText: text, write: { kind: "document", itemKey: itemKey(sessionId, "note"), documentType: "soap_note", title: "Visit note (SOAP)", text, language: note.language } });
    }
    for (const id of approval.selection.updates) {
      const update = note.proposedUpdates.find((candidate) => candidate.id === id);
      // The database already refused anything that is not a new item of this note; this is the same rule again.
      if (!update || update.relation !== "new") throw new RouteError("forbidden", "Only new, non-conflicting items can be written to the chart");
      const key = itemKey(sessionId, id);
      const detail = update.detail ?? undefined;
      if (update.kind === "allergy") {
        const intolerance = /^intolerance/i.test(detail ?? "");
        items.push({ item: id, copyText: `${intolerance ? "Intolerance" : "Allergy"}: ${update.name}${detail ? ` (${detail})` : ""}`,
          write: { kind: "allergy", itemKey: key, substance: update.name, reaction: detail, intolerance, confirmedByPhysician: confirmedAllergies.includes(id) } });
      } else if (update.kind === "condition") {
        items.push({ item: id, copyText: `Problem: ${update.name}${detail ? ` (${detail})` : ""}`, write: { kind: "condition", itemKey: key, name: update.name, detail } });
      } else if (update.kind === "medication") {
        items.push({ item: id, copyText: `Patient-reported medicine: ${update.name}${detail ? `, ${detail}` : ""}`, write: { kind: "medication", itemKey: key, name: update.name, dosageText: detail } });
      } else {
        // A spoken measurement is part of the note text. It is not created as a separate coded observation.
        throw new RouteError("invalid_request", "Measurements are recorded in the note and cannot be selected separately");
      }
    }
    return items;
  }

  async function view(id: string): Promise<ScribeSessionView> {
    const { session, segments, writes } = await load(id);
    let results: ChartWriteResult[] = [];
    if (session.approval && session.note) {
      // Copy text is offered for whatever the EHR did not take.
      const planned = plannedItems(session.id, session.note, session.approval);
      results = planned.map(({ item, write, copyText }) => {
        const stored = writes.find((entry) => entry.itemKey === write.itemKey);
        const status = stored?.status ?? "pending";
        return { itemKey: write.itemKey, item, resourceType: RESOURCE_OF[write.kind], status, resourceId: stored?.resourceId, failure: stored?.failure,
          ...(status === "created" || status === "existing" ? {} : { copyText }) };
      });
    }
    return {
      id: session.id, status: session.status, consentConfirmedAt: session.consentConfirmedAt, spokenLanguage: session.spokenLanguage, noteLanguage: session.noteLanguage,
      segments, transcriptDeleted: session.transcriptDeleted, transcriptExpiresAt: session.transcriptExpiresAt, note: session.note, noteVersion: session.noteVersion,
      approval: session.approval, approvedAt: session.approvedAt, audioSeconds: session.audioSeconds, spendUsd: Number(session.spendUsd.toFixed(6)), writes: results, createdAt: session.createdAt,
    };
  }

  return {
    capabilities(actor: ClinicianContext): ScribeCapabilities {
      return {
        enabled: config.enabled && !!actor.encounterId && actor.scopes.includes("scribe:record"), reason: config.enabled ? undefined : config.disabledReason ?? "The scribe is not switched on for this hospital",
        spokenLanguage: config.spokenLanguage, noteLanguage: config.noteLanguage, maxMinutes: config.maxVisitMinutes, chunkSeconds: config.chunkSeconds,
        transcriptRetentionDays: config.transcriptRetentionDays, liveTranscription: deps.transcription.live,
        canApprove: actor.roles.includes("physician") && actor.scopes.includes("chart:write"),
      };
    },
    get: async (actor: ClinicianContext, id: string) => { requireActor(actor); return view(id); },
    list: async (actor: ClinicianContext) => { requireActor(actor); return deps.repository.list(); },

    /** Recording starts only with the clinician's statement that the patient agreed. The statement is stored with the visit. */
    async start(actor: ClinicianContext, input: { patientConsentConfirmed: true; idempotencyKey: string }) {
      requireActor(actor);
      if (input.patientConsentConfirmed !== true) throw new RouteError("forbidden", "Confirm that the patient agreed to the recording");
      const session = await deps.repository.start({
        id: input.idempotencyKey, consentStatement: CONSENT_STATEMENT, spokenLanguage: config.spokenLanguage, noteLanguage: config.noteLanguage,
        transcriptExpiresAt: new Date(Date.now() + config.transcriptRetentionDays * 86_400_000),
      });
      return view(session.id);
    },

    /**
     * One audio chunk: checked, transcribed from memory and dropped. Only the recognized sentences
     * are stored. A chunk that was already stored is acknowledged without a second provider call.
     */
    async addChunk(actor: ClinicianContext, id: string, chunk: { index: number; durationMs: number; mimeType: string; audio: Uint8Array }) {
      requireActor(actor);
      if (!Number.isInteger(chunk.index) || chunk.index < 0 || chunk.index > 999 || !Number.isFinite(chunk.durationMs) || chunk.durationMs < 200 || chunk.durationMs > MAX_CHUNK_SECONDS * 1000 ||
          !AUDIO_TYPES.test(chunk.mimeType) || chunk.audio.byteLength < 100 || chunk.audio.byteLength > MAX_CHUNK_BYTES) {
        throw new RouteError("invalid_request", "This part of the recording could not be accepted");
      }
      const { session, segments } = await load(id);
      if (session.status !== "recording") throw new RouteError("conflict", "This recording has ended");
      const seconds = chunk.durationMs / 1000;
      if (session.audioSeconds + seconds > config.maxVisitMinutes * 60) throw new RouteError("conflict", `The recording limit of ${config.maxVisitMinutes} minutes has been reached. End the recording to write the note.`);
      if (session.spendUsd >= config.maxVisitUsd) throw new RouteError("conflict", "The spending limit for one visit has been reached. End the recording to write the note.");
      let hints = deps.hints?.get(id);
      if (!hints) {
        // Medicine, problem and allergy names from the chart help the recognizer. Names of things, never of people.
        hints = (await chart(actor)).grounded.facts.filter((fact) => ["medication", "problem", "allergy"].includes(fact.category) && fact.status === "known").map((fact) => fact.label.slice(0, 60)).slice(0, 30);
        deps.hints?.set(id, hints);
      }
      const result = await deps.transcription.transcribe({ audio: chunk.audio, sequence: chunk.index, mimeType: chunk.mimeType, durationSeconds: seconds, language: session.spokenLanguage, hints, dataClassification: classification });
      const sentences = toSentences(result.segments);
      const { added } = await deps.repository.addChunk(id, chunk.index, sentences, seconds, result.estimatedCostUsd);
      return { index: chunk.index, added, sentences: added ? sentences.length : 0, segmentsBefore: segments.length };
    },

    /** Ends the recording and writes the note in one model call. The result always awaits the physician. */
    async generateNote(actor: ClinicianContext, id: string) {
      requireActor(actor);
      const { session, segments } = await load(id);
      if (!["recording", "transcribed", "note_ready"].includes(session.status)) throw new RouteError("conflict", "This note was already approved");
      if (session.transcriptDeleted) throw new RouteError("conflict", "The transcript of this visit has been deleted");
      if (session.spendUsd >= config.maxVisitUsd) throw new RouteError("conflict", "The spending limit for this visit has been reached");
      await deps.repository.stop(id);
      const { patient, grounded } = await chart(actor);
      const { note, speakers } = await generateScribeNote({ provider: deps.noteProvider, safety: deps.safety, dataClassification: classification },
        { segments, facts: grounded.facts, demographics: patientDemographics(patient), noteLanguage: session.noteLanguage, spokenLanguage: session.spokenLanguage });
      await deps.repository.saveNote(id, note, speakers, note.usage?.estimatedCostUsd ?? 0);
      return view(id);
    },

    /** The physician's own edits. An edited or added statement is marked as theirs; sources of untouched statements stay. */
    async editNote(actor: ClinicianContext, id: string, input: { expectedVersion: number; sections: Record<SoapSection, { id?: string; text: string }[]> }) {
      requireActor(actor);
      const { session } = await load(id);
      if (!session.note || session.status !== "note_ready") throw new RouteError("conflict", "There is no note to edit");
      const safety = await deps.safety.assess(SOAP_SECTIONS.flatMap((section) => input.sections[section].map((statement) => statement.text)).join("\n") || "-");
      if (safety.level === "blocked") throw new RouteError("safety_blocked", "The edit contains text that cannot be saved");
      const sections = Object.fromEntries(SOAP_SECTIONS.map((section) => [section, input.sections[section].map((statement, index): NoteStatement => {
        const original = session.note!.sections[section].find((candidate) => candidate.id === statement.id);
        const unchanged = original && original.text === statement.text;
        return { id: `${section[0]}${index + 1}`, text: statement.text, sources: original?.sources ?? [], ...(unchanged ? (original.editedByClinician ? { editedByClinician: true } : {}) : { editedByClinician: true }) };
      })])) as Record<SoapSection, NoteStatement[]>;
      await deps.repository.editNote(id, input.expectedVersion, { ...session.note, sections });
      return view(id);
    },

    async relabel(actor: ClinicianContext, id: string, speakers: { id: string; speaker: ScribeSpeaker | null }[]) {
      requireActor(actor);
      await deps.repository.relabel(id, speakers);
      return view(id);
    },

    async discard(actor: ClinicianContext, id: string) {
      requireActor(actor);
      await deps.repository.discard(id);
    },

    /**
     * The only path that writes to the chart. The physician approves one version of the note and
     * names each item; the database records that approval and refuses any item outside it; each
     * item is then created at most once in the EHR. Repeating the call resumes, never duplicates.
     */
    async approveAndWrite(actor: ClinicianContext, id: string, input: { expectedVersion: number; selection: ScribeApproval["selection"] }) {
      requireActor(actor, true);
      const before = await load(id);
      if (!before.session.note) throw new RouteError("conflict", "There is no note to approve");
      // Refuse an invalid selection before anything is recorded.
      plannedItems(id, before.session.note, { noteVersion: input.expectedVersion, selection: input.selection });
      const approved = await deps.repository.approve(id, input.expectedVersion, input.selection);
      const items = plannedItems(id, approved.note!, approved.approval!);
      const counts = { created: 0, existing: 0, failed: 0, unsupported: 0 };
      let noteInChart = false;
      for (const { item, write } of items) {
        const origin = item === "note" ? "scribe_note" as const : "scribe_update" as const;
        const resourceType = RESOURCE_OF[write.kind];
        const opened = await deps.ledger.begin(origin, id, write.itemKey, resourceType);
        let status = opened.status;
        let resourceId = opened.resourceId;
        if (status !== "created" && status !== "existing") {
          const outcome = deps.writer ? await deps.writer.create(write) : { status: "unsupported" as const, resourceType, failure: "Writing to the chart is not switched on for this session" };
          await deps.ledger.record(write.itemKey, outcome.status, outcome.resourceId, outcome.failure);
          status = outcome.status;
          resourceId = outcome.resourceId;
          deps.audit?.({ action: "scribe.chart_write", tenantId: actor.tenantId, clinicianId: actor.clinicianId, sessionId: id, itemKey: write.itemKey, resourceType, status, resourceId });
        }
        counts[status as keyof typeof counts]++;
        if (item === "note" && (status === "created" || status === "existing")) noteInChart = true;
      }
      await deps.repository.finish(id, { noteInChart, ...counts });
      return view(id);
    },
  };
}
