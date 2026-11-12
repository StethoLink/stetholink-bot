/**
 * Plain-text layout of a consultation request. The server renders it, the physician may edit
 * it, and the interface parses it back to show each statement beside its chart sources.
 * A statement cites chart facts as trailing `[fact-id]` markers.
 */
export const REFERRAL_SECTIONS = [
  { key: "relevantHistory", title: "Relevant history" },
  { key: "presentingSymptoms", title: "Presenting symptoms" },
  { key: "examinationFindings", title: "Examination findings" },
  { key: "investigations", title: "Available investigations" },
  { key: "currentMedications", title: "Current medications" },
  { key: "clinicalContext", title: "Other clinical context" },
] as const;

export type ReferralSectionKey = (typeof REFERRAL_SECTIONS)[number]["key"];

export const EMPTY_SECTION_TEXT = "Nothing from the chart was included.";
export const MISSING_INFORMATION_TITLE = "Missing information (recorded in the chart as not available)";
export const SUGGESTION_PREFIX = "AI suggestion, not from the chart: ";

export interface ReferralStatement {
  text: string;
  evidenceIds: string[];
}

export interface ParsedReferral {
  /** "Label: value" lines before the first section, e.g. the clinical question. */
  header: { label: string; value: string }[];
  sections: { title: string; statements: ReferralStatement[] }[];
  /** Lines that fit no section, kept so physician edits are never hidden. */
  other: string[];
}

const CITATION = /\s*\[([^\[\]]{1,200})\]\s*$/;

/** Splits "text [id-1] [id-2; source; date]" into the text and the cited fact ids. */
export function parseStatement(line: string): ReferralStatement {
  let text = line.replace(/^\s*[-•]\s*/, "").trim();
  const evidenceIds: string[] = [];
  for (let match = CITATION.exec(text); match; match = CITATION.exec(text)) {
    evidenceIds.unshift(match[1].split(";")[0].trim());
    text = text.slice(0, match.index).trim();
  }
  return { text, evidenceIds };
}

export function renderStatement(statement: ReferralStatement) {
  return `- ${statement.text}${statement.evidenceIds.map((id) => ` [${id}]`).join("")}`;
}

export function parseReferralText(text: string): ParsedReferral {
  const parsed: ParsedReferral = { header: [], sections: [], other: [] };
  let current: ParsedReferral["sections"][number] | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const bullet = /^[-•]\s+/.test(line);
    if (!bullet && line.endsWith(":")) {
      current = { title: line.slice(0, -1), statements: [] };
      parsed.sections.push(current);
    } else if (bullet && current) {
      const statement = parseStatement(line);
      if (statement.text !== EMPTY_SECTION_TEXT) current.statements.push(statement);
    } else if (!current && !bullet && /^[^:]{1,60}:\s+\S/.test(line)) {
      const split = line.indexOf(":");
      parsed.header.push({ label: line.slice(0, split).trim(), value: line.slice(split + 1).trim() });
    } else if (bullet) {
      parsed.other.push(parseStatement(line).text);
    } else {
      parsed.other.push(line);
    }
  }
  return parsed;
}

/** Every fact id cited anywhere in the text. */
export function citedEvidenceIds(text: string) {
  const ids = new Set<string>();
  for (const line of text.split("\n")) for (const id of parseStatement(line).evidenceIds) ids.add(id);
  return [...ids];
}
