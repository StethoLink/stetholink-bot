# Proposal: information stated by the physician as a source for consultations (not implemented)

Status: design for review. Product decision Q6 asked for a design only in this round. Workboard task T19.

## Problem

A consultation draft may only state what the chart documents. A physician often knows something the chart does not hold yet: what the patient just said, an examination finding, a result seen on paper. Today the physician can type it into the request or an answer, and the model may use it to word the clinical question, but it cannot appear in the findings, because every finding must cite a chart fact. The physician then edits the draft by hand, and the edited sentence carries no source.

In the scribe this problem does not arise: the transcript is the source.

## Proposal

Add a second kind of source, kept apart from chart facts everywhere it appears.

1. **Capture.** A field in the composer, "Add something that is not in the chart", takes short statements, one per line. Each is stored with the draft as a `PhysicianStatement`: `{ id: "stated-1", text, statedBy: <clinician id from the session>, statedAt }`. It is never merged into `clinicalFacts`.
2. **Model input.** Statements are sent in their own array, `physicianStatements`, beside `chart.facts`. The instruction says: a statement may be restated in a section and cited by its id; it is the physician's own report and is not checked against the chart.
3. **Validation.** A statement citing a `stated-…` id is accepted only if at least half of its content words and every figure are in that statement (the rule already used for chart facts). A sentence may not cite a chart fact and a physician statement together, so the two origins never blend in one claim.
4. **Display.** The source chip reads "Stated by the physician" in a neutral colour, never "Source: chart". The source list has a separate group with the same heading, with the physician's name and the time.
5. **Text and envelope.** In the consultation text each such line ends with the marker `(stated by the physician)`. The envelope gains `physicianStatements: [{ id, text }]`, so the specialist sees which information is the physician's own report and which is documented. This is a change to provider contract 1.0 and needs a contract version bump.
6. **Conflicts.** If a statement contradicts a chart fact (the model reports it as a `conflicts_with_chart` concern), the physician is asked before drafting, as today. Nothing is resolved automatically.
7. **Chart.** A physician statement is not written to the EHR as a separate record. If the physician wants it in the chart, it belongs in the note (scribe) or in the EHR itself.
8. **Database.** `clinical_metadata` gains `physicianStatements`; the dispatch command compares the envelope's statements with the stored ones, like the text. One migration; no change to row-level security.

## What must not happen

- A physician statement must never be shown, stored or sent as a chart fact, or satisfy a citation that needs one.
- The model must not turn a statement into a diagnosis, a normal finding or a dose that the statement does not contain.
- A non-physician's statement is labelled with that person's role; approval remains the physician's.

## Work

Contracts and schemas (S), authoring prompt and validation (M), composer and source display (M), envelope and SQL comparison with a contract version bump (M), tests and evaluation cases (M).
