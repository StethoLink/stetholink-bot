# Order drafting

The physician writes what they want in their own words, in English or Arabic, and StethoLink drafts the orders:

- **Specific:** "Prepare a CBC and a chest X-ray" drafts exactly those orders, no others.
- **For the case:** "Prepare the basic orders for this case" (or "…the chest pain set") proposes orders the chart supports. If the request names one of the hospital's order sets, only that set's orders can be proposed.

Every order is a **draft**. A mapped physician approves or rejects each order one by one (see *Approval* below); nothing is signed, sent or written to the EHR by the drafting step.

## What is guaranteed

| Rule | How it is kept |
| --- | --- |
| Only the hospital's orders | The model chooses entries of the catalog by id. An id that is not in the catalog is dropped. The code, product, dose, route and frequency of an order are copied from the catalog entry; the model never writes them, and an answer that contains one is refused (`core/orders/authoring.ts`). |
| A specific request drafts what was asked | An order is kept only if the physician's words contain its catalog name or one of its synonyms, whole words, in either language. Orders the model adds on its own are dropped. |
| A proposal rests on the chart | An order the physician did not name is kept only with at least one cited chart fact that is documented (not "unknown") and not in conflict. Every cited fact is stored with the draft, so the physician reads the citation beside the order. At most 12 are proposed. |
| Nothing the chart cannot show is claimed | Allergy, duplicate and interaction checks say so ("allergies not checked", "interactions not checked") when the chart's list could not be read. |
| The model sees no identity | The request goes through the same de-identification layer as every model call (`getModelProvider`). The model receives age, sex, the visit reason, the chart's facts and the catalog's names (id, kind, display, synonyms): no name, no identifier, no code, no dose. |

## The checks on each order

The flags use the chart and the hospital's own catalog. StethoLink adds no clinical knowledge of its own: where the catalog has no allergy words or interaction rule, nothing is flagged for it.

| Flag | When |
| --- | --- |
| `allergy` | A documented allergy mentions one of the order's `allergyTerms` (for a medication also its `matchTerms`). Needs an acknowledgement and a reason before approval. |
| `allergies_unchecked` | The chart holds no readable allergy entry (not even "no known allergy"). |
| `duplicate_active` | The medicine is already an active medication in the chart. |
| `duplicate_order` | The same catalog order is already pending or approved in this visit (by anyone). |
| `interaction` | One of the catalog's `interactions` rules joins a group of this medication with a group of an active medication or of another medication in the same draft. A **major** interaction needs an acknowledgement and a reason before approval. |
| `interactions_unchecked` | The chart's active medications could not be read, so the rules could not be applied. |

## The catalog file

`ORDER_CATALOG_FILE` is the path of a JSON file the hospital owns and maintains. Without it order drafting is off and the screen says so. The file is checked when the server starts: an unreadable, malformed or oversized file stops the server and the message names the place in the file (never its contents). **StethoLink ships no order, code, dose or interaction rule; the example below only shows the shape, its values are placeholders.**

```json
{
  "version": "2026-11-01",
  "items": [
    {
      "id": "lab-example",
      "kind": "lab",
      "display": "Example laboratory test",
      "synonyms": ["ELT", "example test"],
      "code": { "system": "<your code system>", "code": "<your code>" },
      "matchTerms": [],
      "groups": [],
      "allergyTerms": []
    },
    {
      "id": "med-example",
      "kind": "medication",
      "display": "Example medicine 100 mg tablet",
      "synonyms": ["example medicine"],
      "medication": { "product": "Example medicine", "dose": "100 mg", "route": "oral", "frequency": "once daily", "duration": "5 days" },
      "matchTerms": ["example medicine"],
      "groups": ["example-group"],
      "allergyTerms": ["example allergy word"]
    }
  ],
  "sets": [
    { "id": "set-example", "name": "Example set", "synonyms": ["example basics"], "itemIds": ["lab-example"] }
  ],
  "interactions": [
    { "groups": ["example-group", "other-group"], "severity": "major", "text": "The hospital's own sentence shown to the physician." }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `version` | Stored with every draft, so a draft always shows which catalog it came from. Change it when the content changes. |
| `items[].id` | Unique, stable. The model chooses by this id. |
| `kind` | `lab`, `imaging`, `medication` or `nursing`. |
| `display`, `synonyms` | How the order is named to the physician and the other names they may write ("CBC", the Arabic name). Matching ignores case, accents, Arabic diacritics and the common spellings of alef, ya and ta marbuta, and accepts the Arabic article and the joined Arabic "and". |
| `code` | The EHR's own code, copied unchanged into the written order. Optional. |
| `medication` | Required for a medication and refused for any other kind: exactly what may be ordered. Nobody can change a dose in a draft. |
| `matchTerms` | Words that name this medicine in a chart's active medications (generic name, brand, class). |
| `groups` | The groups the interaction rules refer to. |
| `allergyTerms` | Chart allergy words that make the order unsafe ("penicillin" for amoxicillin). |
| `sets[]` | Order sets the physician can name; `itemIds` must exist. |
| `interactions[]` | Rules between two groups, `severity` `major`, `moderate` or `minor`, and the hospital's own text. |

**Who maintains it.** The hospital: its pharmacy and laboratory leads decide which orders may be drafted, with their codes, doses and interactions, and change the file under the hospital's own change control. A new `version` takes effect when the server restarts.

**Size.** The whole catalog is sent to the model with the chart, about 130 bytes an order. The default input limit (`OPENAI_MAX_INPUT_TOKENS`, 16000 bytes) fits about 30 orders; `ORDER_MAX_INPUT_TOKENS` (at most 120000) sets a larger limit for order drafting only, and about 800 orders are the most that fit. A larger request costs more: raise `OPENAI_MAX_COST_USD` (at most 1) when the call's worst case, input limit and output limit at the configured rates, is above it, or retries are refused. A catalog that cannot leave room for a chart stops the server at start and says which setting to raise.

## Permissions and storage

- Every mapped clinician receives `order:draft` and can draft and read their own drafts of the visit. Only a mapped **physician** receives `order:approve`, with `chart:write` for writing to the EHR. The EHR token grants none of these (`platform/auth/smart-session.ts`).
- Drafts are stored in PostgreSQL (`order_drafts`, `order_lines`, `order_events`, `order_idempotency`), readable only by the clinician who drafted them, on that chart, with row-level security. Lines are written only by the database command that checks the session; a line's content cannot change afterwards, and a decision, once made, is final. The audit trail holds identifiers and counts, never the request or an order's text.
- A repeated request with the same idempotency key returns the stored draft without asking the model again; the same key for another request is refused with 409.

## Interface

`POST /api/orders/drafts` `{ request, idempotencyKey }` returns the draft (201), or `{ "outcome": "no_match", … }` (200, nothing stored) when no order could be drafted. `GET /api/orders/drafts` lists the visit's drafts; `GET /api/orders/drafts/:id` reads one. Without the catalog every route answers 501 "not set up". Contracts: `shared/contracts/orders.ts`, `shared/schemas/orders.ts`.
