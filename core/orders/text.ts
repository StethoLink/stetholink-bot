/**
 * Matching of the physician's words, chart entries and catalog names. English and Arabic: case, accents,
 * Arabic diacritics and the common spellings of alef, ya and ta marbuta do not make two words different.
 */
const ARABIC_MARKS = /[ً-ٰٟـ]/g;

export function normalize(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(ARABIC_MARKS, "")
    .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
const words = (text: string) => normalize(text).split(" ").filter(Boolean);

/** The Arabic article is part of the word's spelling, not of its meaning: "الصدر" and "صدر" are the same word here. */
const stem = (word: string) => word.replace(/^ال(?=\p{L}{3,})/u, "");

/**
 * One word of the text against one word of the phrase. Arabic writes "and" as a letter joined to the next word, so the
 * first word of a phrase may carry it ("وأشعة صدر" contains "أشعة صدر"). `longer` also accepts a longer form of the
 * phrase's word ("Penicillins" for "penicillin"), which only the safety checks want.
 */
function sameWord(source: string, target: string, first: boolean, longer: boolean): boolean {
  const [s, t] = [stem(source), stem(target)];
  if (s === t || (longer && t.length >= 4 && s.startsWith(t))) return true;
  if (!first || !source.startsWith("و") || source.length < 4) return false;
  const rest = stem(source.slice(1));
  return rest === t || (longer && t.length >= 4 && rest.startsWith(t));
}

function containsWords(text: string, phrase: string, longer: boolean): boolean {
  const target = words(phrase);
  const source = words(text);
  if (!target.length || target.length > source.length) return false;
  for (let start = 0; start + target.length <= source.length; start++) {
    if (target.every((word, offset) => sameWord(source[start + offset], word, offset === 0, longer))) return true;
  }
  return false;
}

/** The words of `phrase` appear in `text`, whole and in order. Used for what the physician asked for: a near miss is not a request. */
export const containsPhrase = (text: string, phrase: string): boolean => containsWords(text, phrase, false);

/**
 * The chart text mentions the term, allowing a longer form of each word ("penicillin" in "Penicillins", "penicillin V").
 * Used for allergies and active medications, where missing a match is the unsafe mistake, so it errs towards matching.
 */
export const mentionsTerm = (text: string, term: string): boolean => containsWords(text, term, true);
