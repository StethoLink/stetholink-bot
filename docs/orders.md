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

## Approval

Only a mapped physician (role `physician` in `SMART_CLINICIAN_MAP`, so `order:approve`) decides, and decides each order one by one: approve or reject, any number of lines in one command that either succeeds or changes nothing. A non-physician cannot approve, whatever their session claims: the application refuses it and PostgreSQL refuses it again.

- An order flagged for an **allergy** or a **major interaction** is approved only with that flag acknowledged and a reason of at least 10 characters. The acknowledgement and the reason are stored with the line and written into the EHR order's note. Other flags (duplicates, moderate or minor interactions, "not checked") do not block approval; they stay visible beside the order.
- A line that was decided is not decided again, by anyone. The command carries the draft's version and an idempotency key: a stale version is refused (409), and a retry of the same command returns its first result.
- Approval changes only StethoLink's own record. It writes nothing to the EHR.

## Writing to the EHR

After approval the physician chooses to write the approved orders to the chart. Each approved order becomes one FHIR `ServiceRequest` (laboratory, imaging, nursing) or `MedicationRequest` (medication), created conditionally under a key derived from the line, so a repeat creates nothing more. Only `create` is ever issued, never an update or a delete, and pending or rejected orders are never written (the write ledger in PostgreSQL opens a row only for a line this physician approved, as the resource its kind needs).

- The record carries the catalog's own code (when the catalog gave one) and name, the medication's product and dose as the catalog states them, the launched patient and visit, the physician as requester and a note saying it was approved by the ordering physician, with the acknowledgement and reason where one was needed.
- **Status.** `FHIR_ORDER_STATUS=draft` (the default) writes `status: draft, intent: order`: the order waits in the EHR for the physician to sign and release it there, so nothing is collected or dispensed because of the write. `active` places the order at once; choose it only when the hospital's process wants that.
- **Where the EHR takes no write**, the order is offered as text for the clinician to enter, and the screen says so. The decision is made for each resource: the EHR must have granted the create scope (`patient/ServiceRequest.c`, `patient/MedicationRequest.c`, or `.write` in SMART v1) and its capability statement must declare `create` for the resource. **OpenEMR 7.0.3 has no `ServiceRequest` and offers `MedicationRequest` for reading only**, so every approved order there is shown as text ([openemr.md](openemr.md), "What OpenEMR 7.0.3's FHIR API accepts for orders"). The write to a hospital EHR that does accept the resources has been exercised against a fake FHIR server in `tests/e2e/live-ehr-flow.mts` only; it is unverified on any real EHR.

## On the screen

The **Orders** tab sits between Consultations and History (Alt + 3), in English and in Arabic (right to left), from a 360 px panel up. Every text is in `apps/embedded-app/i18n/work.ts` (`orders`), in both languages.

- **The request.** A box for the physician's own words with two examples ("Prepare a CBC and a chest X-ray", "Prepare the basic orders for this case"), and below it the earlier drafts of the visit (the request, and how many orders await a decision, are approved or are rejected). While the model works the tab shows progress and a Cancel button; pressing the button again after a cancel or a timeout returns the draft if the server finished it (the same idempotency key).
- **Nothing matched.** A request the catalog cannot serve stores nothing. The tab shows which words matched no order and how many orders the assistant named that were dropped, and lets the physician change the request.
- **Not set up.** Without `ORDER_CATALOG_FILE` the server answers 501, and the tab says that order drafting is not set up and to ask the administrator; it offers no request box. A session opened before orders existed (no `order:draft`) is told to launch StethoLink again from the chart.
- **The draft.** The orders are grouped by kind (laboratory, imaging, medications, nursing). Each shows its kind, the catalog's own name and code and, for a medicine, its product, dose, route, frequency and duration; who asked for it (the physician's own words, or "proposed by the assistant", with the reason and the chart facts it cites shown beside it); its checks; and its status. What matched nothing, what the assistant named that was dropped, what the chart did not give and what was not loaded from the chart are shown with the draft.
- **The checks, in words.** Each flag has a title and a tone: an allergy and a major interaction are red; a duplicate, a moderate interaction and "not checked" are amber; a minor interaction is neutral. The sentence is built on the screen from the flag's kind, its severity and the labels of the chart facts it cites; the flag's own `text` is an English sentence and is shown in neither language. An interaction adds the hospital's own text as written. The screen says that no warning does not mean an order is safe.
- **The decision (a physician only).** Each pending order has Approve and Reject for a physician with `order:approve`; anyone else sees no decision control and a line saying that a physician must approve. An allergy or a major interaction shows an acknowledgement box and a reason field (at least 10 characters, as the server requires). "Record my decisions" stays off until every chosen approval has what it needs; it then asks in a dialog that says the decision is final and writes nothing to the EHR. One command records all the chosen orders or none. If the draft changed meanwhile (409) it is reloaded and the choices are cleared.
- **In the patient's chart.** The approved orders are listed with their state. A physician with `chart:write` can write them to the chart (a dialog says what is created). Where the EHR cannot receive an order, or a write failed, the screen says "Your EHR cannot receive these orders" (or that the write failed) and shows the text of each order to enter by hand, with **Copy text** and **Copy all as text**. The clipboard can be blocked inside an EHR's frame; the screen then says so instead of failing without a word. Anyone else sees the approved orders as text and is told that only a physician can write them.

## Permissions and storage

- Every mapped clinician receives `order:draft` and can draft and read their own drafts of the visit. Only a mapped **physician** receives `order:approve`, with `chart:write` for writing to the EHR. A draft is visible to the clinician who drafted it only, so a physician decides on their own drafts, not on a colleague's. The EHR token grants none of these (`platform/auth/smart-session.ts`).
- Drafts are stored in PostgreSQL (`order_drafts`, `order_lines`, `order_events`, `order_idempotency`), readable only by the clinician who drafted them, on that chart, with row-level security. Lines are written only by the database command that checks the session; a line's content cannot change afterwards, and a decision, once made, is final. The audit trail holds identifiers and counts, never the request or an order's text.
- A repeated request with the same idempotency key returns the stored draft without asking the model again; the same key for another request is refused with 409.

## Interface

`POST /api/orders/drafts` `{ request, idempotencyKey }` returns the draft (201), or `{ "outcome": "no_match", … }` (200, nothing stored) when no order could be drafted. `GET /api/orders/drafts` lists the visit's drafts; `GET /api/orders/drafts/:id` reads one; `POST /api/orders/drafts/:id/decisions` `{ draftId, expectedVersion, idempotencyKey, decisions: [{ lineId, decision, acknowledged?, overrideReason? }] }` records the physician's decisions; `GET` and `POST /api/orders/drafts/:id/chart` list and write the approved orders (`ChartWriteResult[]`, with `copyText` for what is not in the chart). Without the catalog every route answers 501 "not set up". Contracts: `shared/contracts/orders.ts`, `shared/schemas/orders.ts`.
