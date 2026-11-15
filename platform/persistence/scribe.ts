import "server-only";
import { z } from "zod";
import type { TransactionSql } from "postgres";
import type { ClinicianContext } from "@/core/auth/clinician";
import { RouteError } from "@/core/errors";
import type { ChartWriteLedger, ScribeRepository, StoredChartWrite, StoredScribeSession } from "@/core/scribe/repository";
import type { TranscriptSegment } from "@/shared/contracts";
import { scribeApprovalSchema, scribeNoteSchema, scribeStatusSchema } from "@/shared/schemas";
import { database } from "./database";

const rowSchema = z.object({
  id: z.string(), status: scribeStatusSchema, consent_confirmed_at: z.coerce.date(), spoken_language: z.string(), note_language: z.enum(["en", "ar"]),
  note: scribeNoteSchema.nullable(), note_version: z.number().int(), approval: scribeApprovalSchema.nullable(), approved_at: z.coerce.date().nullable(),
  audio_seconds: z.coerce.number(), spend_usd: z.coerce.number(), transcript_expires_at: z.coerce.date(), transcript_deleted_at: z.coerce.date().nullable(), created_at: z.coerce.date(),
});
function fromRow(value: unknown): StoredScribeSession {
  const row = rowSchema.parse(value);
  return {
    id: row.id, status: row.status, consentConfirmedAt: row.consent_confirmed_at.toISOString(), spokenLanguage: row.spoken_language, noteLanguage: row.note_language,
    note: row.note, noteVersion: row.note_version, approval: row.approval, approvedAt: row.approved_at?.toISOString(), audioSeconds: row.audio_seconds, spendUsd: row.spend_usd,
    transcriptExpiresAt: row.transcript_expires_at.toISOString(), transcriptDeleted: row.transcript_deleted_at !== null, createdAt: row.created_at.toISOString(),
  };
}
const writeFromRow = (row: { item_key: string; resource_type: string; status: StoredChartWrite["status"]; resource_id: string | null; failure: string | null }): StoredChartWrite =>
  ({ itemKey: row.item_key, resourceType: row.resource_type, status: row.status, resourceId: row.resource_id ?? undefined, failure: row.failure ?? undefined });

function scopedTo(context: ClinicianContext) {
  return function scoped<T>(work: (tx: TransactionSql) => Promise<T>) {
    return database().begin(async (tx) => {
      // The verified context, including its data classification, is what every policy and command checks.
      await tx`select set_config('statement_timeout', '10000', true), set_config('lock_timeout', '5000', true),
        set_config('stetholink.context', ${JSON.stringify(context)}, true)`;
      return await work(tx);
    }) as Promise<T>;
  };
}

export function createScribeRepository(context: ClinicianContext): ScribeRepository {
  const scoped = scopedTo(context);
  const audit = (tx: TransactionSql, id: string, type: string, detail: object = {}) =>
    tx`insert into public.scribe_events(session_id, tenant_id, clinician_id, event_type, detail) values (${id}, ${context.tenantId}, ${context.clinicianId}, ${type}, ${tx.json(detail as never)})`;
  const ordered = (tx: TransactionSql, id: string) => tx`select chunk_index, seq, speaker, started_ms, ended_ms, content from public.scribe_segments where session_id = ${id} order by chunk_index, seq`;
  return {
    async start(input) {
      if (!context.encounterId) throw new RouteError("forbidden", "A visit is required to record");
      return scoped(async (tx) => {
        const [existing] = await tx`select * from public.scribe_sessions where id = ${input.id}`;
        if (existing) return fromRow(existing);
        const [row] = await tx`insert into public.scribe_sessions(id, tenant_id, clinician_id, patient_id, encounter_id, data_classification, consent_confirmed_at, consent_statement,
            spoken_language, note_language, transcript_expires_at)
          values (${input.id}, ${context.tenantId}, ${context.clinicianId}, ${context.patientId}, ${context.encounterId!}, ${context.dataClassification}, clock_timestamp(), ${input.consentStatement},
            ${input.spokenLanguage}, ${input.noteLanguage}, ${input.transcriptExpiresAt}) returning *`;
        await audit(tx, input.id, "consent_confirmed", { statement: "patient_agreed_verbally" });
        return fromRow(row);
      });
    },
    async get(id) {
      return scoped(async (tx) => {
        const [row] = await tx`select * from public.scribe_sessions where id = ${id}`;
        if (!row) return null;
        const segments: TranscriptSegment[] = (await ordered(tx, id)).map((segment, index) => ({ id: `s${index + 1}`, speaker: segment.speaker, startMs: segment.started_ms, endMs: segment.ended_ms, text: segment.content }));
        const writes = await tx`select item_key, resource_type, status, resource_id, failure from public.chart_writes
          where origin_kind in ('scribe_note','scribe_update') and origin_id = ${id} order by id`;
        return { session: fromRow(row), segments, writes: writes.map((write) => writeFromRow(write as never)) };
      });
    },
    async list() {
      return scoped(async (tx) => (await tx`select id, status, created_at, audio_seconds from public.scribe_sessions where status <> 'discarded' order by created_at desc limit 20`)
        .map((row) => ({ id: row.id, status: row.status, createdAt: row.created_at.toISOString(), audioSeconds: Number(row.audio_seconds) })));
    },
    async addChunk(id, chunkIndex, sentences, audioSeconds, costUsd) {
      return scoped(async (tx) => {
        const [session] = await tx`select status from public.scribe_sessions where id = ${id} for update`;
        if (!session) throw new RouteError("not_found", "Visit not found");
        if (session.status !== "recording") throw new RouteError("conflict", "This recording has ended");
        // A marker row per chunk makes a repeated upload a no-op, even when the chunk was silent.
        const [seen] = await tx`select 1 from public.scribe_segments where session_id = ${id} and chunk_index = ${chunkIndex} limit 1`;
        if (seen) return { added: false };
        for (const [seq, sentence] of sentences.entries()) {
          await tx`insert into public.scribe_segments(session_id, chunk_index, seq, started_ms, ended_ms, content) values (${id}, ${chunkIndex}, ${seq}, ${sentence.startMs}, ${sentence.endMs}, ${sentence.text})`;
        }
        await tx`update public.scribe_sessions set audio_seconds = audio_seconds + ${audioSeconds}, spend_usd = spend_usd + ${costUsd}, updated_at = clock_timestamp() where id = ${id}`;
        return { added: true };
      });
    },
    async stop(id) {
      await scoped(async (tx) => {
        const rows = await tx`update public.scribe_sessions set status = 'transcribed', updated_at = clock_timestamp() where id = ${id} and status = 'recording' returning id`;
        if (rows.length) await audit(tx, id, "recording_stopped");
      });
    },
    async saveNote(id, note, speakers, costUsd) {
      return scoped(async (tx) => {
        const [row] = await tx`update public.scribe_sessions set status = 'note_ready', note = ${tx.json(note as never)}, note_version = note_version + 1,
          spend_usd = spend_usd + ${costUsd}, updated_at = clock_timestamp() where id = ${id} and status in ('recording','transcribed','note_ready') returning *`;
        if (!row) throw new RouteError("conflict", "The note can no longer be regenerated");
        for (const [index, segment] of (await ordered(tx, id)).entries()) {
          const speaker = speakers.get(`s${index + 1}`);
          if (speaker) await tx`update public.scribe_segments set speaker = ${speaker} where session_id = ${id} and chunk_index = ${segment.chunk_index} and seq = ${segment.seq}`;
        }
        await audit(tx, id, "note_generated", { noteVersion: row.note_version, statements: Object.values(note.sections).flat().length, removed: note.rejectedStatements, proposals: note.proposedUpdates.length, model: note.provenance.model });
        return fromRow(row);
      });
    },
    async editNote(id, expectedVersion, note) {
      return scoped(async (tx) => {
        const [row] = await tx`update public.scribe_sessions set note = ${tx.json(note as never)}, note_version = note_version + 1, updated_at = clock_timestamp()
          where id = ${id} and status = 'note_ready' and note_version = ${expectedVersion} returning *`;
        if (!row) throw new RouteError("conflict", "The note changed or was already approved. Reload it");
        await audit(tx, id, "note_edited", { noteVersion: row.note_version });
        return fromRow(row);
      });
    },
    async relabel(id, speakers) {
      await scoped(async (tx) => {
        const rows = await ordered(tx, id);
        for (const entry of speakers) {
          const segment = rows[Number(entry.id.slice(1)) - 1];
          if (!segment) throw new RouteError("invalid_request", "Unknown transcript segment");
          await tx`update public.scribe_segments set speaker = ${entry.speaker} where session_id = ${id} and chunk_index = ${segment.chunk_index} and seq = ${segment.seq}`;
        }
      });
    },
    async approve(id, version, selection) {
      return scoped(async (tx) => {
        const [row] = await tx`select * from public.approve_scribe_note(${id}, ${version}, ${tx.json(selection as never)})`;
        return fromRow(row);
      });
    },
    async discard(id) {
      await scoped(async (tx) => {
        const rows = await tx`update public.scribe_sessions set status = 'discarded', note = null, transcript_deleted_at = clock_timestamp(), updated_at = clock_timestamp()
          where id = ${id} and status in ('recording','transcribed','note_ready') returning id`;
        if (!rows.length) throw new RouteError("conflict", "An approved note cannot be discarded");
        await tx`delete from public.scribe_segments where session_id = ${id}`;
        await audit(tx, id, "discarded");
      });
    },
    async finish(id, outcome) {
      await scoped(async (tx) => { await tx`select 1 from public.finish_scribe_session(${id}, ${tx.json(outcome as never)})`; });
    },
  };
}

export function createChartWriteLedger(context: ClinicianContext): ChartWriteLedger {
  const scoped = scopedTo(context);
  return {
    async begin(origin, originId, itemKey, resourceType) {
      return scoped(async (tx) => {
        const [row] = await tx`select item_key, resource_type, status, resource_id, failure from public.begin_chart_write(${origin}, ${originId}, ${itemKey}, ${resourceType})`;
        return writeFromRow(row as never);
      });
    },
    async record(itemKey, status, resourceId, failure) {
      await scoped(async (tx) => { await tx`select 1 from public.record_chart_write(${itemKey}, ${status}, ${resourceId ?? null}, ${failure ?? null})`; });
    },
    async forOrigin(origins, originId) {
      return scoped(async (tx) => (await tx`select item_key, resource_type, status, resource_id, failure from public.chart_writes
        where origin_kind in ${tx(origins)} and origin_id = ${originId} order by id`).map((row) => writeFromRow(row as never)));
    },
  };
}
