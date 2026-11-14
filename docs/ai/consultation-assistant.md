# Consultation assistant

The physician asks for a consultation in plain language. A language model drafts the request from the open chart; the physician reviews, revises, and approves or rejects it. Only synthetic charts are supported.

## What the model does and does not do

| The model | The model never |
| --- | --- |
| Reads the physician's request, their answers, the normalized chart facts and the patient's age and sex | Sees the name, birth date, identifiers, tokens or the database |
| Questions a request that does not fit the chart or is unclear, before drafting | Diagnoses, orders, prescribes or changes the chart |
| Names the specialty and words the clinical question | Drafts while it is still questioning the request, unless the physician chooses to proceed |
| Restates relevant documented facts, citing each one | Approves, rejects, chooses a provider or sends |
| Suggests kinds of information the specialist may need | Has any tool; it returns one JSON object and nothing else |

## Age and sex

Every consultation states the patient's age and sex as header lines (`Age: 68 years`, `Sex: Male`), and `grounding.patient` holds the same values. The server computes the age from the chart's birth date when the draft is written (`core/consultation/demographics.ts`): days under one month, months under two years, years after that, and "90 years or older" from 90. A missing or invalid birth date or an unknown sex reads "Not recorded"; nothing is guessed. The name, the birth date and chart identifiers are never sent to the model or the specialist.

## Questioning the request

Before drafting, the model reviews the request as a senior colleague would and returns a verdict (`requestReview`). It challenges the request only when there is a reason, and says so plainly:

| Kind | When |
| --- | --- |
| `missing_specialty` | No specialty is named (added by the server even if the model does not) |
| `specialty_fit` | The chart documents nothing for that specialty, or points to another one |
| `unclear_question` | The request does not say what the specialist should answer |
| `conflicts_with_chart` | The request states something the chart contradicts or does not document |
| `missing_information` | Something the specialist cannot answer without is absent |
| `urgency` | Documented findings may need more urgent attention than the request reflects |

A clear request that fits the chart is drafted directly. A challenge comes back from `POST /api/consultations/drafts` as `200 { outcome: "clarification_needed", concerns, clarifications, canAnswer }` and nothing is stored. Each concern states the problem, asks one question and cites the chart facts it relies on. The physician then:

- **answers**: the same request is sent again with `clarifications: [{ question, answer }]`; the model treats the answers as the physician's decisions and does not ask the same thing twice;
- **prepares it anyway** with `proceed: true`: the draft is written and the remaining concerns are stored in `grounding.authoring.overriddenConcerns`, shown prominently with the draft and never sent to the specialist (not possible without a specialty);
- or **changes the request**.

At most six answers are accepted for one request (`canAnswer` becomes false; only proceeding or rewriting remains). Concerns are validated like statements: a concern citing an unknown fact, adding a figure that is not in the request, answers or chart, or carrying markup is dropped, and a challenge whose reasons all fail is retried rather than ignored. Answers are part of the idempotency fingerprint.

## How a draft is checked

The model returns structured JSON (`core/consultation/authoring.ts`). Before anything is stored:

1. The JSON must match the schema exactly. Otherwise the model is asked once more, then the request fails.
2. Every statement must cite known, non-conflicting chart facts. A statement is removed if it cites nothing, cites an unknown item, contains a figure that is not in its cited facts, adds a negative, normal, severity or diagnostic word its facts do not contain, or shares less than half its content with them. The number removed is shown to the physician.
3. If most statements fail, or the model used nothing from the chart, the whole draft is refused.
4. Missing information is written from the chart's own "not available" items, not from the model.
5. Suggestions that contain figures or treatment or ordering verbs are dropped. They are shown apart, labelled as not from the chart.
6. Text carrying structured-output debris (braces, backslashes, brackets, markup) is dropped. A yes/no finding is shown by its name ("Atrial fibrillation", never "Atrial fibrillation: true").
7. The rendered text and any concerns pass the existing safety check (markup, control characters, approval or treatment claims).

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
| `OPENAI_MAX_COST_USD` | Worst-case cost allowed for one call including retries (default 0.25) |
| `AI_DAILY_BUDGET_USD` | Total allowed per server instance per UTC day (default 2) |
| `OPENAI_MAX_INPUT_TOKENS`, `OPENAI_MAX_OUTPUT_TOKENS` | Token bounds (defaults 16000 and 8000). Reasoning tokens count as output |
| `OPENAI_REASONING_EFFORT` | Optional, for reasoning models |
| `OPENAI_TIMEOUT_MS`, `OPENAI_MAX_RETRIES` | One deadline covers all attempts (defaults 90000 and 1; maximum 120000). The drafting and revision routes allow 120 s |
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

## Live verification record

On 2026-11-12 the live tests and the browser walk-through passed with `OPENAI_MODEL=gpt-5` (served as `gpt-5-2025-08-07`), `OPENAI_REASONING_EFFORT=low`, `OPENAI_MAX_OUTPUT_TOKENS=8000`, `OPENAI_TIMEOUT_MS=60000`, on the fictional Omar chart, from a development container against a disposable local PostgreSQL. A draft took about 21 s (2,095 input and 1,300 output tokens) and a revision about 30 s. The specialist was the simulated provider. This was not a cloud deployment, and the cost figures shown were computed from placeholder upper-bound rates, not verified prices.

At this latency the former defaults were too tight for this model. On 2026-11-14, at default reasoning effort, a draft or revision took 15-30 s and a challenge about 14 s, with 2,500-4,400 output tokens (reasoning tokens count as output, so the former 2,048 cap would cut the response off). The defaults are therefore `OPENAI_TIMEOUT_MS=90000`, `OPENAI_MAX_OUTPUT_TOKENS=8000` and `OPENAI_MAX_COST_USD=0.25`. `OPENAI_REASONING_EFFORT=low` brings calls to 10-16 s, but in one run it left the presentation troponin out of an ACS consultation, so it is not the default. Note for development containers: an outbound proxy that ends requests at 30 s makes longer calls fail with 502 regardless of these settings.
