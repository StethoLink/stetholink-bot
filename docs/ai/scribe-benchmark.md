# Scribe: transcription benchmark, provider choice and cost

Measured on 2026-11-15 with `scripts/scribe-benchmark.mjs`. Raw results, including every transcript, are in [`scribe-benchmark.json`](scribe-benchmark.json).

## What was measured

- **Material:** ten fictional clinic visits in Saudi Arabic with English clinical terms (`core/agent/evaluations/scribe/dialogues.json`): 84 turns, 8.8 minutes of audio. Each has a script, the key terms that must survive (medicines, doses and readings, allergies) and the chart it is compared with.
- **Audio:** synthetic speech (OpenAI `gpt-4o-mini-tts`, two voices, instructed to speak Najdi dialect), encoded as the browser records it: mono Opus, 24 kbit/s. **No human recording was used.**
- **Call:** each visit sent whole to each model, language `ar`. "Chart hints" means the chart's medicine and problem names were passed as the recognition prompt, as the product does.
- **Scores:** word error rate after normalising Arabic letter forms, diacritics, digits and punctuation; share of key terms found (accepting Arabic or Latin spelling and digits or words); share of speaking time attributed to the right speaker, for models that separate voices; list price; processing time.

## Results

| Model | Word error rate | Medicines | Doses and readings | Allergies | Speakers | USD per minute | Seconds per audio minute |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OpenAI `gpt-4o-mini-transcribe` | 16.7% | 73% | 86% | 60% | not offered | 0.003 | 2.2 |
| OpenAI `gpt-4o-mini-transcribe` with chart hints | 16.7% | 80% | 86% | 60% | not offered | 0.003 | 1.8 |
| **OpenAI `gpt-transcribe` with chart hints** | **8.8%** | **87%** | **100%** | **100%** | not offered | **0.0045** | 2.1 |
| OpenAI `gpt-4o-transcribe` with chart hints | 14.8% | 60% | 90% | 80% | not offered | 0.006 | 2.5 |
| OpenAI `whisper-1` with chart hints | 19.2% | 60% | 76% | 80% | not offered | 0.006 | 4.2 |
| OpenAI `gpt-4o-transcribe-diarize` | 30.4% | 40% | 67% | 60% | 87% | 0.006 | 17.8 |
| ElevenLabs `scribe_v1` | 11.7% | 100% | 100% | 80% | 59% | 0.0067 | 1.4 |
| ElevenLabs `scribe_v2` | 11.2% | 100% | 100% | 80% | 58% | 0.0067 | 1.4 |

Key terms: 15 medicines, 21 doses and readings, 5 allergy mentions. One missed allergy is 20 points.

Not measured, because no key was available: Deepgram, AssemblyAI, Azure Speech, self-hosted Whisper. List prices found for them (third-party pages, to be confirmed with each vendor): AssemblyAI Universal-2 about $0.0025/min, Deepgram Nova-3 $0.0043 to $0.0077/min, Azure Speech about $0.0167/min. None of the pages found confirms Saudi-dialect quality, so price alone does not qualify them.

## Choice

**Quality bar** (set before choosing): at least 85% of medicine names, 95% of doses and readings and 95% of allergy mentions recognised, and a word error rate of 12% or lower. A missed or wrong medicine, dose or allergy is the error that matters clinically; general wording errors are corrected by the note model and by the physician.

- `gpt-4o-mini-transcribe` is the cheapest and fails the bar: it missed 2 of 5 allergy mentions and 4 of 15 medicines. Chart hints did not fix it.
- **`gpt-transcribe` is the cheapest model that clears the bar** (87%, 100%, 100%, 8.8%). It is the default: `TRANSCRIPTION_PROVIDER=openai`, `TRANSCRIPTION_MODEL=gpt-transcribe`.
- ElevenLabs `scribe_v2` recognised every medicine and dose, heard one allergen wrongly ("sulfa" as "sulfur"), and costs about 50% more. It is implemented as the alternative (`TRANSCRIPTION_PROVIDER=elevenlabs`, `TRANSCRIPTION_MODEL=scribe_v2`).
- Third-party pages report that OpenAI will retire `gpt-4o-mini-transcribe`, `gpt-4o-transcribe` and `whisper-1` on 2027-02-26 and names `gpt-transcribe` as the replacement, which also argues against the cheaper model. Confirm on OpenAI's deprecations page.

**Speakers.** No model both transcribes well and separates speakers well on this material: the diarizing OpenAI model is the least accurate transcriber, and ElevenLabs attributed 58% of speaking time correctly on the two synthetic voices. The product therefore does not depend on voice separation. The note model marks which sentences the clinician spoke (from what is said), assessment and plan must quote the clinician, and the physician can correct or swap the labels in the review screen.

## Cost of one visit

| Part | Basis | Cost for 15 minutes |
| --- | --- | --- |
| Transcription, `gpt-transcribe` | $0.0045 per minute, list price | $0.0675 |
| Note, `gpt-5-mini`, reasoning effort `low`, one call | measured on a 15-minute transcript: 5,226 input and 2,638 output tokens at $0.25 and $2.00 per million | $0.0066 |
| **Total** | | **$0.074** |

- The target was under $0.10 for a 15-minute visit. The measured total is $0.074.
- The 15-minute transcript was built by joining the fictional visits to that length; a single real visit of that length may produce a longer note. With twice the output tokens the note costs $0.012 and the total is $0.079.
- On the ten separate visits (about one minute each) the note cost $0.0033 and took 16 seconds on average; the 15-minute note took 39 seconds.
- Silent parts are not uploaded, so a visit with pauses costs less than its clock time.
- The per-visit ceiling is `SCRIBE_MAX_VISIT_USD` (default $0.50). Recording stops being accepted at `SCRIBE_MAX_VISIT_MINUTES` (default 45).
- Prices are list prices found in November 2026. The operator sets `TRANSCRIPTION_USD_PER_MINUTE` and the note model rates after confirming them; the server refuses a transcription price above `TRANSCRIPTION_MAX_USD_PER_MINUTE`.

## Note quality on the same visits

`tests/backend/scribe-note-live.test.ts` (opt-in, real model) drafts a note for each of the ten visits and checks it against the expected properties. Result with `gpt-5-mini`: 10 of 10 passed; 79 statements drafted, 3 removed by validation (3.8%); every chart conflict was surfaced and linked to the chart fact (patient denies allergies while the chart records penicillin; warfarin stopped while the chart lists it active; a different lisinopril dose); every new allergy and patient-reported medicine was proposed as new. One weakness seen: where the clinician said a reaction was an intolerance and not an allergy, the first prompt version proposed it as an allergy; the instruction was tightened, and the item is written as `type: intolerance` and unconfirmed unless the physician confirms it.

## Limits of this benchmark

- Synthetic voices are cleaner than a clinic: no overlap, background noise, distance from the microphone or strong dialect variation. Real accuracy will be lower. **Repeat the benchmark with consented, human recordings of fictional scripted visits before a pilot** (the script and scorer are ready; put the audio in `.cache/scribe-benchmark/`).
- 8.8 minutes and 41 key terms is a small sample. Differences of a few points are not meaningful; the failures of the cheapest model are large enough to be.
- Each visit was sent whole. The product sends 20 to 30 second parts cut at pauses; a word at a forced cut can be lost.

## Reproduce

```bash
OPENAI_API_KEY=... ELEVENLABS_API_KEY=... node scripts/scribe-benchmark.mjs --dialogues 10 --out docs/ai/scribe-benchmark.json
```

```bash
RUN_SCRIBE_LIVE_EVAL=1 OPENAI_API_KEY=... SCRIBE_NOTE_MODEL=gpt-5-mini npx vitest run tests/backend/scribe-note-live.test.ts
```
