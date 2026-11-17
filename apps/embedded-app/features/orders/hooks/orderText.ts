import type { ClinicalFact, OrderDraft, OrderFlag, OrderKind, OrderLine, OrderLineDecision } from "@/shared/contracts";
import { factLabel, factValue } from "@/apps/embedded-app/i18n/chart-text";
import type { Locale, Messages } from "@/apps/embedded-app/i18n/messages";
import type { Tone } from "@/apps/embedded-app/components/ui";

type OrderTexts = Messages["work"]["orders"];

/** The order of the groups on the screen. */
export const ORDER_KINDS: readonly OrderKind[] = ["lab", "imaging", "medication", "nursing"];
/** A reason for going ahead shorter than this is refused by the server. It is the server's number (`MIN_OVERRIDE_REASON`); a test checks that they agree. */
export const MIN_REASON = 10;
/** The warnings a physician acknowledges before approving: an allergy, or a major interaction. */
export type AcknowledgementKind = "allergy" | "interaction";
export const ACKNOWLEDGEMENT_KINDS: readonly AcknowledgementKind[] = ["allergy", "interaction"];

/** The kinds of warning this order needs acknowledged. The server's rule (`requiredAcknowledgements`); a test checks that they agree. */
export function requiredKinds(flags: readonly Pick<OrderFlag, "kind" | "severity">[]): AcknowledgementKind[] {
  const needed = new Set<AcknowledgementKind>();
  for (const flag of flags) {
    if (flag.kind === "allergy") needed.add("allergy");
    if (flag.kind === "interaction" && flag.severity === "major") needed.add("interaction");
  }
  return ACKNOWLEDGEMENT_KINDS.filter((kind) => needed.has(kind));
}

/** The lines of a draft by kind, in the order of the screen; a kind with no line is left out. */
export function groupByKind(lines: readonly OrderLine[]): { kind: OrderKind; lines: OrderLine[] }[] {
  return ORDER_KINDS.map((kind) => ({ kind, lines: lines.filter((line) => line.kind === kind) })).filter((group) => group.lines.length > 0);
}

/** What the physician has chosen for one pending line, and what an order with a warning needs besides. Held on the screen until it is recorded. */
export interface LineChoice { choice?: "approve" | "reject"; acknowledged: AcknowledgementKind[]; reason: string }
export const noChoice: LineChoice = { acknowledged: [], reason: "" };

/** Whether an approval has what the server will ask for: every required acknowledgement and a reason of enough length. A rejection needs nothing. */
export function isComplete(line: OrderLine, choice: LineChoice | undefined): boolean {
  if (choice?.choice !== "approve") return choice?.choice === "reject";
  const required = requiredKinds(line.flags);
  return required.every((kind) => choice.acknowledged.includes(kind)) && (!required.length || choice.reason.trim().length >= MIN_REASON);
}

/** The command to send for the lines chosen so far, and how many chosen approvals still lack an acknowledgement or a reason. */
export function decisionsToRecord(lines: readonly OrderLine[], choices: Readonly<Record<string, LineChoice | undefined>>): { decisions: OrderLineDecision[]; incomplete: number } {
  const decisions: OrderLineDecision[] = [];
  let incomplete = 0;
  for (const line of lines) {
    const choice = choices[line.id];
    if (line.status !== "pending" || !choice?.choice) continue;
    if (!isComplete(line, choice)) { incomplete += 1; continue; }
    const required = requiredKinds(line.flags);
    decisions.push({ lineId: line.id, decision: choice.choice, ...(choice.choice === "approve" && required.length ? { acknowledged: required, overrideReason: choice.reason.trim() } : {}) });
  }
  return { decisions, incomplete };
}

/** The chart facts a draft stores, by id. */
export const factsOf = (draft: Pick<OrderDraft, "clinicalFacts">): Map<string, ClinicalFact> => new Map(draft.clinicalFacts.map((fact) => [fact.id, fact]));

/** The facts a line cites that the draft holds, in the order cited. */
export function citedFacts(ids: readonly string[], facts: ReadonlyMap<string, ClinicalFact>): ClinicalFact[] {
  return ids.map((id) => facts.get(id)).filter((fact): fact is ClinicalFact => !!fact);
}

/** Words joined in the language's own way ("allergy and interaction"). */
export const joinWords = (items: readonly string[], locale: Locale) => new Intl.ListFormat(locale === "ar" ? "ar" : "en", { style: "long", type: "conjunction" }).format(items);

/** Keeps a value that may be in another script from changing how the words around it are ordered. */
const isolate = (text: string) => `⁨${text}⁩`;
/** A fact in words: its label, and its value in brackets. */
export function describeFact(fact: ClinicalFact, locale: Locale, chart: Messages["chart"]): string {
  const value = factValue(fact, chart);
  return `${factLabel(fact.label, locale)}${value ? ` (${value})` : ""}`;
}

/** What `flagsFor` (core/orders/flags.ts) appends to a hospital's interaction text; a test checks that these are still its words. */
const CONTEXT_MARKERS = [{ marker: " (active medication: ", kind: "active" }, { marker: " (also in this draft: ", kind: "draft" }] as const;
/** An interaction's text as the hospital wrote it, and the context core added to it in English. A text that does not end that way is the hospital's text whole. */
export function splitInteraction(text: string): { rule: string; context?: { kind: "active" | "draft"; what: string } } {
  if (!text.endsWith(")")) return { rule: text };
  const found = CONTEXT_MARKERS.map(({ marker, kind }) => ({ marker, kind, at: text.lastIndexOf(marker) })).filter((entry) => entry.at > 0).sort((a, b) => b.at - a.at)[0];
  return found ? { rule: text.slice(0, found.at), context: { kind: found.kind, what: text.slice(found.at + found.marker.length, -1) } } : { rule: text };
}

export interface FlagView {
  kind: OrderFlag["kind"];
  /** "Allergy", "Major interaction", "Interactions not checked". */
  title: string;
  tone: Tone;
  /** The sentence, built from the kind, the severity and the labels of the facts the flag cites. Empty only for an interaction whose context is not known. */
  sentence: string;
  /** An interaction's own text, as the hospital wrote it. */
  hospitalText?: string;
  /** The physician must acknowledge this warning, with a reason, to approve. */
  needsAcknowledgement: boolean;
}

/**
 * A flag in words, in the language of the screen. The sentence is built here from the flag's kind, its severity and the chart facts it
 * cites, because the flag's own `text` is an English sentence; only an interaction's own text, which is the hospital's, is shown as written.
 */
export function describeFlag(flag: OrderFlag, facts: ReadonlyMap<string, ClinicalFact>, texts: OrderTexts["flags"], locale: Locale, chart: Messages["chart"]): FlagView {
  const cited = citedFacts(flag.evidenceIds, facts);
  const first = cited[0] ? isolate(describeFact(cited[0], locale, chart)) : undefined;
  const needsAcknowledgement = requiredKinds([flag]).length > 0;
  const view = (title: string, tone: Tone, sentence: string, extra: Partial<FlagView> = {}): FlagView => ({ kind: flag.kind, title, tone, sentence, needsAcknowledgement, ...extra });
  const s = texts.sentences;
  switch (flag.kind) {
    case "allergy": return view(texts.kinds.allergy, "danger", first ? s.allergy(first) : s.allergyUnknown);
    case "allergies_unchecked": return view(texts.kinds.allergies_unchecked, "warning", s.allergiesUnchecked);
    case "duplicate_active": return view(texts.kinds.duplicate_active, "warning", first ? s.duplicateActive(first) : s.duplicateActiveUnknown);
    case "duplicate_order": return view(texts.kinds.duplicate_order, "warning", s.duplicateOrder);
    case "interactions_unchecked": return view(texts.kinds.interactions_unchecked, "warning", s.interactionsUnchecked);
    case "interaction": {
      const severity = flag.severity;
      const { rule, context } = splitInteraction(flag.text);
      // An active medication is named by the chart fact the flag cites; another order of the draft only by the words core wrote.
      const what = context?.kind === "active" ? first ?? isolate(context.what) : context ? isolate(context.what) : undefined;
      return view(severity ? texts.interaction[severity] : texts.kinds.interaction, severity === "major" ? "danger" : severity === "moderate" ? "warning" : "neutral",
        context && what ? (context.kind === "active" ? s.withActive(what) : s.withDraft(what)) : "", { hospitalText: rule });
    }
  }
}

/** Copies text for pasting into the EHR. The clipboard is blocked in a frame the EHR did not delegate it to, so a field and the older command are tried next; false means the clinician copies the shown text themselves. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Blocked or unavailable: fall through to the older way.
  }
  try {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    Object.assign(field.style, { position: "fixed", insetBlockStart: "0", insetInlineStart: "0", opacity: "0" });
    document.body.appendChild(field);
    field.select();
    const copied = document.execCommand("copy");
    field.remove();
    return copied;
  } catch {
    return false;
  }
}
