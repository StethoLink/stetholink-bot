// FICTIONAL visit speech for the opt-in real-system checks of the scribe (docs/openemr.md, "Verification of the whole flow").
// Reads one of the ten fictional visits of core/agent/evaluations/scribe/dialogues.json, synthesizes each turn with the OpenAI speech
// model (two voices, spoken in Saudi Arabic), and joins the turns with short pauses into one WAV file that Chromium plays as its
// fake microphone:
//
//   chromium --use-file-for-fake-audio-capture=<out>.wav%noloop --use-fake-device-for-media-stream --use-fake-ui-for-media-stream
//
// There is no human recording anywhere in this repository. The audio is written where you say and is never committed.
//
//   OPENAI_API_KEY=... NODE_USE_ENV_PROXY=1 node tests/e2e/browser/scribe-speech.mjs <dialogue id, e.g. scribe-01-chest-pain> <out.wav> [pause seconds, default 0.7]
//
// Needs ffmpeg. In this repository's cloud container the key is injected by the network proxy: pass OPENAI_API_KEY=proxy-injected.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const [id, out, pauseArg] = process.argv.slice(2);
if (!id || !out) throw new Error("Usage: scribe-speech.mjs <dialogue id> <out.wav> [pause seconds]");
const key = process.env.OPENAI_API_KEY;
if (!key) throw new Error("Set OPENAI_API_KEY");
const base = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const pause = Number(pauseArg ?? 0.7);
const { dialogues } = JSON.parse(readFileSync(new URL("../../../core/agent/evaluations/scribe/dialogues.json", import.meta.url), "utf8"));
const dialogue = dialogues.find((candidate) => candidate.id === id);
if (!dialogue) throw new Error(`No dialogue ${id}. Known: ${dialogues.map((candidate) => candidate.id).join(", ")}`);

const VOICE = { clinician: "ash", patient: "coral" };
const MANNER = {
  clinician: "Speak Saudi Arabic (Najdi dialect) as a physician in a clinic: natural pace, clear. Pronounce English medical terms in English.",
  patient: "Speak Saudi Arabic (Najdi dialect) as a patient in a clinic: conversational, natural hesitations. Pronounce English drug names as a Saudi patient would.",
};
const work = mkdtempSync(join(tmpdir(), "scribe-speech-"));
const files = await Promise.all(dialogue.turns.map(async (turn, index) => {
  const response = await fetch(`${base}/audio/speech`, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: VOICE[turn.speaker], input: turn.text, response_format: "mp3", instructions: MANNER[turn.speaker] }),
  });
  if (!response.ok) throw new Error(`Speech synthesis failed with status ${response.status} on turn ${index}`);
  const file = join(work, `turn-${String(index).padStart(2, "0")}.mp3`);
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  return file;
}));
// 48 kHz mono 16-bit, a pause after every turn, and ten seconds of silence at the end (the part that is still open is cut by the clinician ending the visit).
const inputs = files.flatMap((file) => ["-i", file]);
const chain = files.map((_, index) => `[${index}:a]aresample=48000,aformat=channel_layouts=mono,apad=pad_dur=${pause}[a${index}]`).join(";");
const join_ = files.map((_, index) => `[a${index}]`).join("") + `concat=n=${files.length}:v=0:a=1,apad=pad_dur=10[out]`;
mkdirSync(dirname(out), { recursive: true });
execFileSync("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", `${chain};${join_}`, "-map", "[out]", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", out]);
const seconds = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out]).toString());
console.log(JSON.stringify({ dialogue: id, turns: dialogue.turns.length, seconds: Math.round(seconds), out }));
