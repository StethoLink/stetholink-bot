// Speech-to-text benchmark for the scribe. FICTIONAL visits only: the audio is synthesized (TTS)
// from core/agent/evaluations/scribe/dialogues.json, encoded the way the browser records
// (mono Opus, 24 kbit/s), transcribed by each provider and scored against the script.
//
//   OPENAI_API_KEY=... [ELEVENLABS_API_KEY=...] node scripts/scribe-benchmark.mjs [--dialogues 4] [--out docs/ai/scribe-benchmark.json]
//
// Audio is cached in .cache/scribe-benchmark/ and is never committed. Needs ffmpeg and ffprobe.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => value.startsWith("--") ? [...pairs, [value.slice(2), all[index + 1]]] : pairs, []));
const OPENAI = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const openaiKey = process.env.OPENAI_API_KEY;
const elevenKey = process.env.ELEVENLABS_API_KEY;
if (!openaiKey) throw new Error("Set OPENAI_API_KEY (used for speech synthesis and for the OpenAI transcription models)");
const cache = ".cache/scribe-benchmark";
mkdirSync(cache, { recursive: true });
const { dialogues } = JSON.parse(readFileSync("core/agent/evaluations/scribe/dialogues.json", "utf8"));
const selected = dialogues.slice(0, Number(args.dialogues ?? 4));

// USD per audio minute: list prices found in November 2026. An operator must confirm them before use.
const CANDIDATES = [
  { id: "gpt-4o-mini-transcribe", provider: "openai", usdPerMinute: 0.003, hints: false },
  { id: "gpt-4o-mini-transcribe", label: "gpt-4o-mini-transcribe + chart hints", provider: "openai", usdPerMinute: 0.003, hints: true },
  { id: "gpt-transcribe", provider: "openai", usdPerMinute: 0.0045, hints: true },
  { id: "gpt-4o-transcribe", provider: "openai", usdPerMinute: 0.006, hints: true },
  { id: "whisper-1", provider: "openai", usdPerMinute: 0.006, hints: true },
  { id: "gpt-4o-transcribe-diarize", provider: "openai", usdPerMinute: 0.006, hints: false, diarize: true },
  ...(elevenKey ? [{ id: "scribe_v1", provider: "elevenlabs", usdPerMinute: 0.0067, hints: false, diarize: true }, { id: "scribe_v2", provider: "elevenlabs", usdPerMinute: 0.0067, hints: false, diarize: true }] : []),
];
const VOICE = { clinician: "ash", patient: "coral" };

const duration = (file) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString());

async function synthesize(dialogue) {
  const out = join(cache, `${dialogue.id}.webm`);
  const timeline = join(cache, `${dialogue.id}.json`);
  if (existsSync(out) && existsSync(timeline)) return { file: out, turns: JSON.parse(readFileSync(timeline, "utf8")) };
  const parts = await Promise.all(dialogue.turns.map(async (turn, index) => {
    const file = join(cache, `${dialogue.id}-${index}.mp3`);
    if (!existsSync(file)) {
      const response = await fetch(`${OPENAI}/audio/speech`, {
        method: "POST", headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: VOICE[turn.speaker], input: turn.text, response_format: "mp3",
          instructions: turn.speaker === "clinician"
            ? "Speak Saudi Arabic (Najdi dialect) as a physician in a clinic: natural pace, clear. Pronounce English medical terms in English."
            : "Speak Saudi Arabic (Najdi dialect) as a patient in a clinic: conversational, slightly fast, natural hesitations. Pronounce English drug names as a Saudi patient would." }),
      });
      if (!response.ok) throw new Error(`Speech synthesis failed with status ${response.status}`);
      writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    }
    return file;
  }));
  // Concatenate with short pauses; keep the true speaker timeline for the diarization score.
  const turns = [];
  let at = 0;
  const inputs = [];
  const filters = [];
  parts.forEach((file, index) => {
    const length = duration(file);
    turns.push({ speaker: dialogue.turns[index].speaker, start: at, end: at + length });
    at += length + 0.45;
    inputs.push("-i", file);
    filters.push(`[${index}:a]aresample=48000,apad=pad_dur=0.45[a${index}]`);
  });
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...inputs, "-filter_complex", `${filters.join(";")};${parts.map((_, index) => `[a${index}]`).join("")}concat=n=${parts.length}:v=0:a=1[out]`,
    "-map", "[out]", "-ac", "1", "-c:a", "libopus", "-b:a", "24k", out]);
  writeFileSync(timeline, JSON.stringify(turns));
  return { file: out, turns };
}

/** Arabic and Latin text reduced to comparable words: no diacritics or punctuation, unified letter forms and digits. */
export function normalize(text) {
  return text.normalize("NFKC").toLowerCase()
    .replace(/[ً-ٰٟـ]/g, "").replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/ؤ/g, "و").replace(/ئ/g, "ي")
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit))).replace(/[^\p{L}\p{N}\s.]/gu, " ").replace(/\.(?!\d)/g, " ")
    // One spelling for "milligram" however the model wrote it.
    .replace(/(مللي|ملغم|ملغ|مجم|ملجم|mg)(?![\p{L}])/gu, "ملي").replace(/\s+/g, " ").trim();
}
function wordErrorRate(reference, hypothesis) {
  const a = normalize(reference).split(" ");
  const b = normalize(hypothesis).split(" ").filter(Boolean);
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[b.length] / a.length;
}
function termRecall(dialogue, hypothesis) {
  const text = ` ${normalize(hypothesis)} `;
  const byKind = {};
  const missed = [];
  for (const term of dialogue.keyTerms) {
    const found = term.variants.some((variant) => text.includes(normalize(variant)));
    const group = term.kind === "dose" || term.kind === "vital" ? "numbers" : term.kind === "medication" ? "medications" : term.kind === "allergy" ? "allergies" : "other";
    byKind[group] ??= { found: 0, total: 0 };
    byKind[group].total++;
    if (found) byKind[group].found++; else missed.push(term.term);
  }
  return { byKind, missed };
}
/** Share of spoken time attributed to the right speaker, after mapping each reported speaker to the role it overlaps most. */
function speakerAccuracy(turns, segments) {
  if (!segments?.length) return null;
  const overlap = {};
  for (const segment of segments) for (const turn of turns) {
    const shared = Math.max(0, Math.min(segment.end, turn.end) - Math.max(segment.start, turn.start));
    if (shared > 0) { overlap[segment.speaker] ??= {}; overlap[segment.speaker][turn.speaker] = (overlap[segment.speaker][turn.speaker] ?? 0) + shared; }
  }
  const role = Object.fromEntries(Object.entries(overlap).map(([speaker, roles]) => [speaker, Object.entries(roles).sort((x, y) => y[1] - x[1])[0][0]]));
  let correct = 0;
  let total = 0;
  for (const turn of turns) {
    total += turn.end - turn.start;
    for (const segment of segments) if (role[segment.speaker] === turn.speaker) correct += Math.max(0, Math.min(segment.end, turn.end) - Math.max(segment.start, turn.start));
  }
  return { accuracy: correct / total, speakersReported: Object.keys(overlap).length };
}

async function transcribe(candidate, file, dialogue) {
  const audio = new Blob([readFileSync(file)], { type: "audio/webm" });
  const form = new FormData();
  form.append("file", audio, "visit.webm");
  // Hints are what the product would pass: medicine and problem names from the chart, plus common terms. Never the script.
  const hints = ["Saudi Arabic clinic visit with English medical terms.", ...dialogue.chart.map((fact) => fact.label)].join(" ");
  const started = Date.now();
  let response;
  if (candidate.provider === "openai") {
    form.append("model", candidate.id);
    form.append("language", "ar");
    if (candidate.diarize) { form.append("response_format", "diarized_json"); form.append("chunking_strategy", "auto"); }
    else if (candidate.hints) form.append("prompt", hints);
    response = await fetch(`${OPENAI}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${openaiKey}` }, body: form });
  } else {
    form.append("model_id", candidate.id);
    form.append("language_code", "ara");
    form.append("diarize", "true");
    form.append("tag_audio_events", "false");
    response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": elevenKey }, body: form });
  }
  const latencyMs = Date.now() - started;
  if (!response.ok) return { error: `HTTP ${response.status}`, latencyMs };
  const body = await response.json();
  let segments;
  if (candidate.provider === "openai" && candidate.diarize) segments = (body.segments ?? []).map((segment) => ({ speaker: segment.speaker, start: segment.start, end: segment.end }));
  if (candidate.provider === "elevenlabs") segments = (body.words ?? []).filter((word) => word.type !== "spacing" && word.speaker_id).map((word) => ({ speaker: word.speaker_id, start: word.start, end: word.end }));
  return { text: body.text ?? (body.segments ?? []).map((segment) => segment.text).join(" "), segments, latencyMs };
}

const results = [];
for (const dialogue of selected) {
  const audio = await synthesize(dialogue);
  const seconds = duration(audio.file);
  const reference = dialogue.turns.map((turn) => turn.text).join(" ");
  const outcomes = await Promise.all(CANDIDATES.map((candidate) => transcribe(candidate, audio.file, dialogue).catch((error) => ({ error: String(error.message ?? error), latencyMs: 0 }))));
  for (const [index, candidate] of CANDIDATES.entries()) {
    const outcome = outcomes[index];
    const label = candidate.label ?? candidate.id;
    if (outcome.error) { results.push({ model: label, dialogue: dialogue.id, seconds, error: outcome.error }); console.error(`${label} ${dialogue.id}: ${outcome.error}`); continue; }
    const terms = termRecall(dialogue, outcome.text);
    results.push({
      model: label, provider: candidate.provider, dialogue: dialogue.id, seconds, wer: wordErrorRate(reference, outcome.text), terms: terms.byKind, missed: terms.missed,
      speakers: speakerAccuracy(audio.turns, outcome.segments), latencyMs: outcome.latencyMs, usd: (seconds / 60) * candidate.usdPerMinute, usdPerMinute: candidate.usdPerMinute, transcript: outcome.text,
    });
    console.error(`${label} ${dialogue.id}: WER ${(results.at(-1).wer * 100).toFixed(1)}%, missed [${terms.missed.join(", ")}], ${outcome.latencyMs} ms`);
  }
}

const models = [...new Set(results.map((row) => row.model))];
const summary = models.map((model) => {
  const rows = results.filter((row) => row.model === model && !row.error);
  const failed = results.filter((row) => row.model === model && row.error);
  if (!rows.length) return { model, error: failed[0]?.error ?? "no result" };
  const seconds = rows.reduce((sum, row) => sum + row.seconds, 0);
  const recall = (group) => { const hit = rows.reduce((sum, row) => sum + (row.terms[group]?.found ?? 0), 0); const all = rows.reduce((sum, row) => sum + (row.terms[group]?.total ?? 0), 0); return all ? hit / all : null; };
  const spoken = rows.filter((row) => row.speakers);
  return {
    model, dialogues: rows.length, failed: failed.length, audioMinutes: seconds / 60,
    wer: rows.reduce((sum, row) => sum + row.wer * row.seconds, 0) / seconds,
    medications: recall("medications"), numbers: recall("numbers"), allergies: recall("allergies"), other: recall("other"),
    speakerAccuracy: spoken.length ? spoken.reduce((sum, row) => sum + row.speakers.accuracy, 0) / spoken.length : null,
    usdPerMinute: rows[0].usdPerMinute, secondsPerAudioMinute: rows.reduce((sum, row) => sum + row.latencyMs, 0) / 1000 / (seconds / 60),
  };
});
const pct = (value) => value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(0)}%`;
console.log("| Model | WER | Medicines | Doses and readings | Allergies | Speakers | USD/min | s per audio min |\n| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const row of summary) console.log(row.error ? `| ${row.model} | failed: ${row.error} | | | | | | |`
  : `| ${row.model} | ${(row.wer * 100).toFixed(1)}% | ${pct(row.medications)} | ${pct(row.numbers)} | ${pct(row.allergies)} | ${pct(row.speakerAccuracy)} | ${row.usdPerMinute} | ${row.secondsPerAudioMinute.toFixed(1)} |`);
if (args.out) writeFileSync(args.out, JSON.stringify({ generatedAt: new Date().toISOString(), audio: "synthetic speech (gpt-4o-mini-tts), mono Opus 24 kbit/s", summary, results }, null, 1));
