# Consultation assistant

The physician asks for a consultation in plain language. A language model drafts the request from the open chart; the physician reviews, revises, and approves or rejects it. Only synthetic charts are supported.

## What the model does and does not do

| The model | The model never |
| --- | --- |
| Reads the physician's request and the normalized chart facts | Sees demographics, identifiers, tokens or the database |
| Names the specialty and words the clinical question | Diagnoses, orders, prescribes or changes the chart |
| Restates relevant documented facts, citing each one | Approves, rejects, chooses a provider or sends |
| Suggests kinds of information the specialist may need | Has any tool; it returns one JSON object and nothing else |

## How a draft is checked

The model returns structured JSON (`core/consultation/authoring.ts`). Before anything is stored:

1. The JSON must match the schema exactly. Otherwise the model is asked once more, then the request fails.
2. Every statement must cite known, non-conflicting chart facts. A statement is removed if it cites nothing, cites an unknown item, contains a figure that is not in its cited facts, adds a negative, normal, severity or diagnostic word its facts do not contain, or shares less than half its content with them. The number removed is shown to the physician.
3. If most statements fail, or the model used nothing from the chart, the whole draft is refused.
4. Missing information is written from the chart's own "not available" items, not from the model.
5. Suggestions that contain figures or treatment or ordering verbs are dropped. They are shown apart, labelled as not from the chart.
6. The rendered text passes the existing safety check (markup, control characters, approval or treatment claims).

The complete chart record stays attached to the draft, and the interface lists documented facts the draft did not use. A revision runs the same checks against the facts stored with the draft; it cannot change the specialty, the question or the sources, and it goes through the recorded lifecycle (reopen, revise, resubmit), so the result is again awaiting review.

These checks reduce fabrication; they do not prove a statement is clinically right. A paraphrase can still distort meaning, and relevance is the model's judgement. The physician's review is the control.

## Configuration

Server-side environment variables. Nothing here is exposed to the browser.

| Variable | Purpose |
| --- | --- |
| `AI_PROVIDER` | `mock` (default; deterministic fallback, labelled as not AI) or `openai` |
| `OPENAI_API_KEY` | Server-side key |
| `OPENAI_MODEL` | Model id. Must support the Responses API with strict JSON schema output |
| `OPENAI_INPUT_USD_PER_MILLION`, `OPENAI_OUTPUT_USD_PER_MILLION` | Required. Upper-bound rates you accept; no price is assumed. Calls are refused without them |
| `OPENAI_MAX_COST_USD` | Worst-case cost allowed for one call including retries (default 0.10) |
| `AI_DAILY_BUDGET_USD` | Total allowed per server instance per UTC day (default 2) |
| `OPENAI_MAX_INPUT_TOKENS`, `OPENAI_MAX_OUTPUT_TOKENS` | Token bounds (defaults 16000 and 2048). Reasoning models usually need a higher output bound |
| `OPENAI_REASONING_EFFORT` | Optional, for reasoning models |
| `OPENAI_TIMEOUT_MS`, `OPENAI_MAX_RETRIES` | One deadline covers all attempts (defaults 30000 and 1) |
| `STAGING_LIVE_MODEL` | `enabled` lets preview staging use the live model. Default `disabled` |

Each model call logs one `model.call` line: provider, model, task, outcome, reason code, HTTP status, attempts, latency, tokens and estimated cost. Prompts, chart content, model output and keys are never logged. The draft stores provider, model, prompt version, tokens, estimated cost and latency, and the interface shows them.

The daily limit is held in memory per server instance. It does not span instances or survive a restart; a durable limit needs storage (see the Codex handoff).

## Tests

- `tests/backend/referral-authoring.test.ts`, `openai-provider.test.ts`: controlled fixtures and a fake transport. No model is called.
- `tests/backend/openai-referral-live.test.ts`: real inference on the fictional Omar chart (draft, revision, planted instructions, missing specialty). It runs only when asked:

```bash
RUN_OPENAI_REFERRAL_LIVE_TEST=1 OPENAI_API_KEY=... OPENAI_MODEL=... \
OPENAI_INPUT_USD_PER_MILLION=... OPENAI_OUTPUT_USD_PER_MILLION=... OPENAI_MAX_OUTPUT_TOKENS=8000 OPENAI_TIMEOUT_MS=60000 \
npx vitest run tests/backend/openai-referral-live.test.ts
```

A skipped live test is unverified, not passed.

- `tests/e2e/browser/consultation-flow.mjs`: the whole workflow in a browser. Set `EXPECT_LIVE_MODEL=1` to require a model-written draft.
