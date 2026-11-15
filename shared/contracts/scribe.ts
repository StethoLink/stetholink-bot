import type { IsoDateTime } from "@/shared/types";
import type { DataClassification } from "./classification";
import type { ModelUsage } from "./consultation";

export type ScribeSpeaker = "clinician" | "patient" | "other";
export type ScribeStatus = "recording" | "transcribed" | "note_ready" | "approved" | "written" | "discarded";
export type NoteLanguage = "en" | "ar";

/** One sentence of the visit as transcribed. The words are never edited; only the speaker label can be corrected. */
export interface TranscriptSegment {
  /** Position in the conversation: "s1", "s2", ... */
  id: string;
  speaker: ScribeSpeaker | null;
  startMs: number;
  endMs: number;
  text: string;
}

export const SOAP_SECTIONS = ["subjective", "objective", "assessment", "plan"] as const;
export type SoapSection = (typeof SOAP_SECTIONS)[number];

/** Where a statement comes from: words of the visit (with the exact quote) or a documented chart fact. */
export interface NoteSource {
  kind: "transcript" | "chart";
  id: string;
  /** Exact words from the transcript segment. Present for transcript sources. */
  quote?: string;
}
export interface NoteStatement {
  id: string;
  text: string;
  sources: NoteSource[];
  /** True once the physician wrote or changed this statement; it is then the physician's own text. */
  editedByClinician?: boolean;
}

export type ProposedUpdateKind = "allergy" | "condition" | "medication" | "vital_sign";
/**
 * Information heard in the visit that the chart may not hold yet. "new" can be selected by the
 * physician for the chart; "already_in_chart" and "conflicts" are shown and never written.
 */
export interface ProposedChartUpdate {
  id: string;
  kind: ProposedUpdateKind;
  name: string;
  detail: string | null;
  relation: "new" | "already_in_chart" | "conflicts";
  /** The chart fact it repeats or contradicts. */
  chartFactId?: string;
  /** For a conflict: what differs, in one sentence. */
  explanation?: string;
  source: { segmentId: string; quote: string };
}

export interface ScribeNote {
  language: NoteLanguage;
  sections: Record<SoapSection, NoteStatement[]>;
  proposedUpdates: ProposedChartUpdate[];
  /** Model statements and proposals removed because their source did not support them. */
  rejectedStatements: number;
  rejectedUpdates: number;
  provenance: { provider: string; model: string; promptVersion: string; dataClassification: DataClassification; liveInference: boolean };
  usage: ModelUsage | null;
  generatedAt: IsoDateTime;
}

/** `confirmedAllergies` are the selected allergy items the physician confirms personally; the others are written as unconfirmed. */
export interface ScribeSelection { note: boolean; updates: string[]; confirmedAllergies?: string[] }
export interface ScribeApproval { noteVersion: number; selection: ScribeSelection }

export type ChartWriteStatus = "pending" | "created" | "existing" | "failed" | "unsupported";
/** Outcome of one item the physician approved for the chart. */
export interface ChartWriteResult {
  itemKey: string;
  /** "note", or the id of the proposed update. */
  item: string;
  resourceType: string;
  status: ChartWriteStatus;
  /** Identifier the EHR assigned, when it created or already had the resource. */
  resourceId?: string;
  /** Why it was not written, in words for the physician. */
  failure?: string;
  /** Ready-to-paste text when the EHR did not accept the write. */
  copyText?: string;
}

export interface ScribeSessionView {
  id: string;
  status: ScribeStatus;
  consentConfirmedAt: IsoDateTime;
  spokenLanguage: string;
  noteLanguage: NoteLanguage;
  segments: TranscriptSegment[];
  transcriptDeleted: boolean;
  transcriptExpiresAt: IsoDateTime;
  note: ScribeNote | null;
  noteVersion: number;
  approval: ScribeApproval | null;
  approvedAt?: IsoDateTime;
  audioSeconds: number;
  spendUsd: number;
  writes: ChartWriteResult[];
  createdAt: IsoDateTime;
}

export interface ScribeSessionSummary { id: string; status: ScribeStatus; createdAt: IsoDateTime; audioSeconds: number }

/** What the interface needs to know before recording. No secrets. */
export interface ScribeCapabilities {
  enabled: boolean;
  /** Why the scribe is off, for the clinician. */
  reason?: string;
  spokenLanguage: string;
  noteLanguage: NoteLanguage;
  maxMinutes: number;
  chunkSeconds: number;
  transcriptRetentionDays: number;
  /** False for the deterministic stand-ins used in development. */
  liveTranscription: boolean;
  canApprove: boolean;
}
