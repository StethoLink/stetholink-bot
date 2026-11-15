import type { ChartWriteStatus, NoteLanguage, ScribeApproval, ScribeNote, ScribeSessionSummary, ScribeSpeaker, ScribeStatus, TranscriptSegment } from "@/shared/contracts";

export interface StoredScribeSession {
  id: string;
  status: ScribeStatus;
  consentConfirmedAt: string;
  spokenLanguage: string;
  noteLanguage: NoteLanguage;
  note: ScribeNote | null;
  noteVersion: number;
  approval: ScribeApproval | null;
  approvedAt?: string;
  audioSeconds: number;
  spendUsd: number;
  transcriptExpiresAt: string;
  transcriptDeleted: boolean;
  createdAt: string;
}
export interface StoredChartWrite { itemKey: string; resourceType: string; status: ChartWriteStatus; resourceId?: string; failure?: string }
export type ChartWriteOrigin = "scribe_note" | "scribe_update" | "consultation" | "specialist_report";

/** Durable scribe state. Every method is scoped to the verified clinician's chart and data classification. */
export interface ScribeRepository {
  start(input: { id: string; consentStatement: string; spokenLanguage: string; noteLanguage: NoteLanguage; transcriptExpiresAt: Date }): Promise<StoredScribeSession>;
  get(id: string): Promise<{ session: StoredScribeSession; segments: TranscriptSegment[]; writes: StoredChartWrite[] } | null>;
  list(): Promise<ScribeSessionSummary[]>;
  /** Stores one chunk's sentences once; a repeated upload of the same chunk changes nothing. */
  addChunk(id: string, chunkIndex: number, sentences: { startMs: number; endMs: number; text: string }[], audioSeconds: number, costUsd: number): Promise<{ added: boolean }>;
  stop(id: string): Promise<void>;
  saveNote(id: string, note: ScribeNote, speakers: ReadonlyMap<string, ScribeSpeaker>, costUsd: number): Promise<StoredScribeSession>;
  editNote(id: string, expectedVersion: number, note: ScribeNote): Promise<StoredScribeSession>;
  relabel(id: string, speakers: { id: string; speaker: ScribeSpeaker | null }[]): Promise<void>;
  /** The physician's approval of one note version and of the selected items. Enforced again in the database. */
  approve(id: string, version: number, selection: ScribeApproval["selection"]): Promise<StoredScribeSession>;
  discard(id: string): Promise<void>;
  finish(id: string, outcome: { noteInChart: boolean; created: number; existing: number; failed: number; unsupported: number }): Promise<void>;
}
/** Ledger of what may be, and was, created in the EHR. A row opens only for an origin the physician approved. */
export interface ChartWriteLedger {
  begin(origin: ChartWriteOrigin, originId: string, itemKey: string, resourceType: string): Promise<StoredChartWrite>;
  record(itemKey: string, status: Exclude<ChartWriteStatus, "pending">, resourceId?: string, failure?: string): Promise<void>;
  forOrigin(origin: ChartWriteOrigin[], originId: string): Promise<StoredChartWrite[]>;
}
