import {
  LEXICON_FEMALE, LEXICON_MALE, SURROGATE_FAMILY, SURROGATE_GIVEN_FEMALE, SURROGATE_GIVEN_MALE,
  SURROGATE_INTL_FAMILY, SURROGATE_INTL_FEMALE, SURROGATE_INTL_MALE,
} from "./names";
import type { ChartIdentity } from "./ports";

/**
 * De-identification of text bound for a model provider, and the way back.
 *
 * Out: names of people become stand-in names of the same sex and naming culture, in the script
 * they were written in; identifiers, phone numbers, e-mail addresses, URLs and record references
 * become opaque tokens; calendar dates become day offsets from the visit, so intervals stay true.
 * Age, sex, vitals, laboratory values, units, doses and durations are never touched.
 * Back: every stand-in in the model's answer is replaced with the real value it stood for.
 *
 * All state is the `SurrogateState` object. It holds real identifiers: it lives in server memory
 * only, for one session, and is never logged, stored or sent.
 */
type Script = "ar" | "la";
type Kind = "given" | "family";
type Sex = "male" | "female";
interface Entry { kind: Kind; ar: string; la: string; origAr?: string; origLa?: string }
interface Unit { key: string; script: Script; kind: Kind; parts: string[]; entry: number; known: boolean }
export interface SurrogateState {
  units: Unit[];
  entries: Entry[];
  /** token -> the text it replaced */
  tokens: Map<string, string>;
  tokenFor: Map<string, string>;
  counters: Record<string, number>;
  /** date token -> the date as it was written */
  dateText: Map<string, string>;
  /** Identifiers the chart supplied, normalized, for the outbound check. */
  knownIds: Set<string>;
  /** Day 0 of the relative dates: the visit day, YYYY-MM-DD. */
  anchor: string;
  salt: number;
  revision: number;
  /** Words of the text being processed, in one spelling. */
  avoid: Set<string>;
}

const DAY_MS = 86_400_000;
const MARKS = "\\u064B-\\u065F\\u0670\\u0640";
const marks = new RegExp(`[${MARKS}]`, "g");
const D = "[0-9٠-٩۰-۹]";
const NOT_WORD_BEFORE = "(?<![\\p{L}\\p{N}\\p{M}])";
const NOT_WORD_AFTER = "(?![\\p{L}\\p{N}\\p{M}])";
const TOKEN_KINDS = ["ID", "PHONE", "EMAIL", "URL", "DATE", "ADDRESS", "NAME"] as const;
type TokenKind = (typeof TOKEN_KINDS)[number];
const TOKEN = new RegExp(`(?<![\\p{L}\\p{N}])(?:${TOKEN_KINDS.join("|")})-[A-Z]{1,3}(?![\\p{L}\\p{N}])`, "gu");
const DATE_TOKEN = /(?<![\p{L}\p{N}])T([+-]\d{1,6})d(?: (\d{2}:\d{2}(?::\d{2})?))?(?![\p{L}\p{N}])/gu;
/** Chart fact ids are keyed hashes of the record reference: they identify nothing and must reach the model unchanged. */
const FACT_ID = /^[a-z_]{1,24}-[0-9a-f]{16}$/;

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
const isArabic = (value: string) => /\p{Script=Arabic}/u.test(value);
export const asciiDigits = (value: string) => value.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0));
/** One spelling per name: no diacritics, one alef, one case. The final alef maqsura is kept, so the preposition "على" is never read as a name. */
export function foldName(value: string) {
  return value.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(marks, "").toLowerCase().replace(/ٱ/g, "ا").replace(/ة/g, "ه").replace(/['’`ʿʾ]/g, "");
}
const letters = (n: number) => { let out = ""; for (; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out; return out; };

export function createSurrogateState(anchorDate?: string, now: Date = new Date()): SurrogateState {
  const anchor = anchorDate && Number.isFinite(Date.parse(anchorDate)) ? new Date(anchorDate) : now;
  return {
    units: [], entries: [], tokens: new Map(), tokenFor: new Map(), counters: {}, dateText: new Map(), knownIds: new Set(),
    anchor: anchor.toISOString().slice(0, 10), salt: globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % 997, revision: 0, avoid: new Set(),
  };
}

// ---- Names -------------------------------------------------------------------------------

const LA_PARTICLES = new Set(["al", "el", "bin", "bint", "ibn", "bn", "binti"]);
const AR_PARTICLES = new Set(["بن", "بنت", "ابن", "ال"]);
const RESERVED = new Set([...TOKEN_KINDS.map((kind) => kind.toLowerCase()), "patient", "doctor", "nurse", "unknown", "not", "recorded"]);

/** A name as matchable units: particles dropped, "Abdul Rahman" and a kunya kept as one unit, the article of a family name set aside. */
function nameUnits(text: string, kind: Kind): Array<{ script: Script; parts: string[]; display: string }> {
  const raw = text.normalize("NFKC").split(/[^\p{L}\p{M}\p{N}'’]+/u).filter(Boolean);
  const units: Array<{ script: Script; parts: string[]; display: string }> = [];
  for (let i = 0; i < raw.length; i++) {
    const word = foldName(raw[i]);
    const script: Script = isArabic(word) ? "ar" : "la";
    let parts: string[] | undefined;
    let display = raw[i];
    const next = raw[i + 1] ? foldName(raw[i + 1]) : undefined;
    if (script === "ar") {
      if (AR_PARTICLES.has(word)) continue;
      if ((word === "عبد" || word === "ابو" || word === "ام") && next && isArabic(next)) { parts = [word, next]; display = `${raw[i]} ${raw[i + 1]}`; i++; }
      else if (word.startsWith("عبد") && word.length > 5) parts = ["عبد", word.slice(3)];
      else if (kind === "family" && word.startsWith("ال") && word.length > 4) { parts = [word.slice(2)]; display = raw[i].replace(/^[اأإآ]ل/u, ""); }
      else parts = [word];
    } else {
      if (LA_PARTICLES.has(word)) continue;
      const abd = /^abd(?:[aeu]l)?$/.test(word);
      if ((abd || /^(?:ab[ou]u?|um+)$/.test(word)) && next && !isArabic(next)) {
        const skip = LA_PARTICLES.has(next) && raw[i + 2] ? 1 : 0;
        parts = [abd ? "abd" : word.startsWith("a") ? "abu" : "umm", foldName(raw[i + 1 + skip])];
        display = raw.slice(i, i + 2 + skip).join(" ");
        i += 1 + skip;
      } else {
        const joined = /^(abd(?:[aeu][lr]?)?)(.{3,})$/.exec(word);
        if (joined && word.length >= 8) parts = ["abd", joined[2]];
        else if (kind === "family" && /^(?:al|el)[a-z]{4,}$/.test(word)) { parts = [word.slice(2)]; display = raw[i].slice(2); }
        else parts = [word];
      }
    }
    const size = parts.join("").length;
    if (size < (script === "ar" ? 2 : 3) || RESERVED.has(parts.join(" ")) || /^\p{N}+$/u.test(parts.join(""))) continue;
    units.push({ script, parts, display });
  }
  return units;
}

const AR_CLASS: Record<string, string> = { "ا": "[اأإآٱ]", "ه": "[هة]", "و": "[وؤ]", "ي": "[يئ]", "ى": "[ىي]" };
function arPattern(word: string) {
  const chars = [...word];
  return chars.map((char, index) => (char === "ي" && index === chars.length - 1 && word !== "علي" ? "[يىئ]" : AR_CLASS[char] ?? escape(char)) + `[${MARKS}]*`).join("");
}
/** Common transliteration variants of one Latin name: doubled consonants and the usual vowel spellings. Names under four letters match exactly. */
function laPattern(word: string) {
  if (word.length < 4) return escape(word);
  const collapsed = word.replace(/(.)\1+/g, "$1").replace(/[ou]+/g, "o").replace(/ei|[iy]+/g, "i");
  const body = [...collapsed].map((char, index) => char === "a" ? "[ae]+" : char === "e" ? "[eai]+" : char === "i" ? "[iye]+" : char === "o" ? "[ou]+"
    : char === "k" || char === "q" ? "[kq]+" : char === "h" && index === collapsed.length - 1 && index > 0 ? "h*" : /[a-z]/.test(char) ? `${char}+` : escape(char)).join("");
  // "Sara" and "Sarah", "Huda" and "Hudah".
  return /[aeiou]$/.test(collapsed) ? `${body}h?` : body;
}
const AR_CLITIC = "(?:[وف]?[بكل]?)";
/** Source of the optional prefix (kept as written) and of the name itself. */
function patternOf(script: Script, kind: Kind, parts: readonly string[]) {
  if (script === "ar") {
    const core = parts.length === 2 && parts[0] === "ابو" ? `[اأ]ب[وياى][\\s\\-]*${arPattern(parts[1])}`
      : parts.length === 2 && parts[0] === "ام" ? `[اأ]م[\\s\\-]*${arPattern(parts[1])}` : parts.map(arPattern).join("[\\s\\-]*");
    return { prefix: kind === "family" ? `${AR_CLITIC}(?:[اأ]?ل)?` : AR_CLITIC, core };
  }
  const core = parts.length === 2 && parts[0] === "abd" ? `abd(?:[aeu][lr]?)?[\\s\\-]*(?:[ae]l[\\s\\-]*)?${laPattern(parts[1])}`
    : parts.length === 2 && parts[0] === "abu" ? `ab[ou]u?[\\s\\-]*${laPattern(parts[1])}`
    : parts.length === 2 && parts[0] === "umm" ? `um+[\\s\\-]*${laPattern(parts[1])}` : parts.map(laPattern).join("[\\s\\-]*");
  return { prefix: kind === "family" ? "(?:(?:al|el)[\\s\\-]?)?" : "", core };
}

const lexicon = (list: ReadonlyArray<{ ar: string; la: string }>, sex: Sex) => list.filter((name) => !name.ar.includes(" ")).map((name) => ({ ...name, sex }));
const GIVEN = [...lexicon(LEXICON_MALE, "male"), ...lexicon(SURROGATE_GIVEN_MALE, "male"), ...lexicon(LEXICON_FEMALE, "female"), ...lexicon(SURROGATE_GIVEN_FEMALE, "female")];
const AR_LEXICON = new Map(GIVEN.map((name) => [foldName(name.ar), name.sex]));
const laLexicon = (sex: Sex) => new RegExp(`^(?:${GIVEN.filter((name) => name.sex === sex).map((name) => {
  const unit = nameUnits(name.la, "given")[0];
  return unit ? patternOf("la", "given", unit.parts).core : escape(foldName(name.la));
}).join("|")})$`, "u");
const LA_MALE = laLexicon("male");
const LA_FEMALE = laLexicon("female");
const laSex = (folded: string): Sex | undefined => LA_MALE.test(folded) ? "male" : LA_FEMALE.test(folded) ? "female" : undefined;

function pickEntry(state: SurrogateState, kind: Kind, sex: Sex, arab: boolean, own: string) {
  const pool = arab ? (kind === "family" ? SURROGATE_FAMILY : sex === "female" ? SURROGATE_GIVEN_FEMALE : SURROGATE_GIVEN_MALE)
    : (kind === "family" ? SURROGATE_INTL_FAMILY : sex === "female" ? SURROGATE_INTL_FEMALE : SURROGATE_INTL_MALE);
  const taken = new Set(state.entries.map((entry) => entry.la));
  // Never a name that is somebody real in this session, the one being replaced included.
  const real = new Set([own, ...state.units.map((unit) => unit.parts.join(""))]);
  for (let i = 0; i < pool.length; i++) {
    const candidate = pool[(state.salt + state.entries.length + i) % pool.length];
    const forms = [foldName(candidate.ar), foldName(candidate.la)];
    if (taken.has(candidate.la) || forms.some((form) => real.has(form) || state.avoid.has(form) || state.avoid.has(`al${form}`) || state.avoid.has(`ال${form}`))) continue;
    return state.entries.push({ kind, ar: candidate.ar, la: candidate.la }) - 1;
  }
  const label = `NAME-${letters(state.counters.NAME = (state.counters.NAME ?? 0) + 1)}`;
  return state.entries.push({ kind, ar: label, la: label }) - 1;
}

function register(state: SurrogateState, unit: { script: Script; parts: string[]; display: string }, kind: Kind, sex: Sex, arab: boolean, known: boolean, share?: number) {
  const key = `${unit.script}:${unit.parts.join(" ")}`;
  const existing = state.units.find((entry) => entry.key === key);
  if (existing) { existing.known ||= known; return existing.entry; }
  const entry = share ?? pickEntry(state, kind, sex, arab, unit.parts.join(""));
  state.units.push({ key, script: unit.script, kind, parts: unit.parts, entry, known });
  const target = state.entries[entry];
  if (unit.script === "ar") target.origAr ??= unit.display; else target.origLa ??= unit.display;
  state.revision++;
  return entry;
}

/** Everything the chart told us about who is who, registered before any text is read. */
export function registerIdentity(state: SurrogateState, identity: ChartIdentity) {
  // No stand-in is taken from the names of the people the chart itself names.
  for (const person of identity.people) for (const name of person.names) {
    for (const word of foldName([name.text, ...(name.given ?? []), name.family].filter(Boolean).join(" ")).match(/[\p{L}\p{M}]{3,}/gu) ?? []) state.avoid.add(word);
  }
  for (const person of identity.people) {
    const lists = person.names.map((name) => {
      const structured = [
        ...(name.given ?? []).flatMap((given, index) => nameUnits(given, "given").map((unit) => ({ unit, kind: "given" as Kind, first: index === 0 }))),
        ...(name.family ? nameUnits(name.family, "family").map((unit) => ({ unit, kind: "family" as Kind, first: false })) : []),
      ];
      if (structured.length || !name.text) return structured;
      const loose = nameUnits(name.text, "given");
      return loose.map((unit, index) => index > 0 && index === loose.length - 1
        ? { unit: nameUnits(unit.display, "family")[0] ?? unit, kind: "family" as Kind, first: false } : { unit, kind: "given" as Kind, first: index === 0 });
    }).filter((list) => list.length);
    const all = lists.flat();
    const first = all.find((item) => item.first)?.unit;
    const sex: Sex = person.sex ?? (first && (first.script === "ar" ? AR_LEXICON.get(first.parts.join("")) : laSex(first.parts.join(""))) || "male");
    const arab = all.some(({ unit }) => unit.script === "ar" || unit.parts.length > 1 || !!laSex(unit.parts.join("")))
      || person.names.some((name) => /(?:^|[\s\-])(?:al|el|bin|bint|ibn)[\s\-]/i.test(`${name.text ?? ""} ${name.family ?? ""}`));
    const arabicLists = lists.filter((list) => list.every(({ unit }) => unit.script === "ar"));
    const done = new Map<typeof lists[number], number[]>();
    for (const list of [...arabicLists, ...lists.filter((list) => !arabicLists.includes(list))]) {
      // The same person in the other script shares the stand-in, name by name.
      const twin = arabicLists.includes(list) ? undefined : arabicLists.find((other) => other.length === list.length && list.every(({ unit }) => unit.script === "la"));
      const shared = twin ? done.get(twin) : undefined;
      done.set(list, list.map((item, index) => register(state, item.unit, item.kind, item.first ? sex : "male", arab, true, shared?.[index])));
    }
    // A display string may hold a word the structured name does not.
    for (const name of person.names) if (name.text) for (const unit of nameUnits(name.text, "given")) register(state, unit, "given", "male", arab, true);
  }
  for (const value of [...identity.identifiers, ...(identity.addresses ?? [])]) {
    const id = normalizeId(value);
    if (id.length >= 3 && !state.knownIds.has(id)) { state.knownIds.add(id); state.revision++; }
  }
}
const normalizeId = (value: string) => asciiDigits(value.normalize("NFKC")).trim().toLowerCase().replace(/\s+/g, " ");

const AR_TITLES = new Map<string, Sex>([["الدكتور", "male"], ["دكتور", "male"], ["الدكتوره", "female"], ["دكتوره", "female"], ["الاستاذ", "male"], ["الاستاذه", "female"],
  ["استاذ", "male"], ["استاذه", "female"], ["السيد", "male"], ["السيده", "female"], ["الشيخ", "male"], ["الممرض", "male"], ["الممرضه", "female"], ["الاخصائي", "male"], ["الاخصائيه", "female"],
  ["اسمي", "male"], ["اسمه", "male"], ["اسمها", "female"], ["اسمك", "male"], ["واسمه", "male"], ["واسمها", "female"], ["المدعو", "male"], ["المدعوه", "female"], ["يا", "male"]]);
const AR_STOP = new Set(["قال", "قالت", "قالي", "يقول", "تقول", "كتب", "كتبت", "طلب", "طلبت", "وصف", "صرف", "عطاني", "اعطاني", "شاف", "شافني", "في", "من", "على", "علي", "الى", "عن", "مع", "هو", "هي",
  "هذا", "هذه", "اللي", "الي", "ما", "لا", "كان", "كانت", "راح", "يبي", "بعد", "قبل", "اليوم", "امس", "بكره", "او", "ثم", "انه", "ان", "لازم", "ممكن", "عند", "عندي", "عندك", "عنده", "حقي", "حقك",
  "دكتور", "دكتوره", "استاذ", "حاج", "حجه", "شيخ", "ابني", "بنتي", "اخي", "اخوي", "اختي", "عم", "عمي", "خاله", "خالتي", "امي", "ابوي", "ولدي", "طويل", "ايش", "وش", "كيف", "ليش", "متى", "وين", "هل"]);
const isNisba = (folded: string) => /^ال.{2,}ي$/u.test(folded);
const LA_TITLES = new Map<string, Sex>([["dr", "male"], ["doctor", "male"], ["mr", "male"], ["mrs", "female"], ["ms", "female"], ["miss", "female"], ["prof", "male"], ["professor", "male"],
  ["nurse", "female"], ["sister", "female"], ["sheikh", "male"], ["eng", "male"], ["named", "male"], ["called", "male"]]);
const LA_STOP = new Set(["hospital", "clinic", "medical", "center", "centre", "reports", "reported", "has", "had", "is", "was", "complains", "denies", "presented", "presents", "the", "and", "with",
  "on", "in", "at", "for", "syndrome", "disease", "said", "says", "asked", "ordered", "prescribed", "will", "who", "from", "about", "regarding", "please", "prepare", "consultation", "department", "ward", "unit"]);

/** Names the chart did not supply: a known given name, or the words after a title, a name cue or a patronymic. */
function detectNames(state: SurrogateState, text: string) {
  const words = [...text.matchAll(/[\p{L}\p{M}'’]+/gu)].map((match) => ({ raw: match[0], folded: foldName(match[0]), arabic: isArabic(match[0]), start: match.index, end: match.index + match[0].length }));
  const knownArabic = new Set(state.units.filter((unit) => unit.script === "ar" && unit.parts.length === 1).map((unit) => unit.parts[0]));
  const gap = (a: number, b: number) => text.slice(words[a].end, words[b].start);
  const add = (raw: string, kind: Kind, sex: Sex, arab = true) => { for (const unit of nameUnits(raw, kind)) register(state, unit, kind, sex, arab, false); };
  let afterName = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const next = words[i + 1];
    let named = false;
    if (word.arabic) {
      const forms = [word.folded, ...(/^[وفبكل]/u.test(word.folded) && word.folded.length >= 4 ? [word.folded.slice(1)] : []), ...(/^[وف][بكل]/u.test(word.folded) && word.folded.length >= 5 ? [word.folded.slice(2)] : [])];
      const hit = forms.find((form) => AR_LEXICON.has(form));
      if (word.folded === "عبد" && next?.arabic && /^\s+$/.test(gap(i, i + 1))) { add(`${word.raw} ${next.raw}`, "given", "male"); i++; named = true; }
      else if (hit) { add(hit, "given", AR_LEXICON.get(hit)!); named = true; }
      else if (forms.some((form) => knownArabic.has(form))) named = true;
      else if (afterName && (word.folded === "بن" || word.folded === "بنت" || word.folded === "ابن") && next?.arabic && !AR_STOP.has(next.folded)) { add(next.raw, "given", "male"); i++; named = true; }
      else if (afterName && (isNisba(word.folded) || (word.folded.startsWith("ال") && AR_LEXICON.has(word.folded.slice(2))))) { add(word.raw, "family", "male"); named = true; }
      else if (AR_TITLES.has(word.folded) && next?.arabic && /^[\s.:،]+$/u.test(gap(i, i + 1)) && !AR_STOP.has(next.folded) && next.folded.length >= 2) {
        if (next.folded.startsWith("ال") && !AR_LEXICON.has(next.folded)) {
          if (isNisba(next.folded) || AR_LEXICON.has(next.folded.slice(2))) { add(next.raw, "family", "male"); i++; named = true; }
        } else { add(next.raw, "given", AR_TITLES.get(word.folded)!); i++; named = true; }
      }
    } else {
      const capital = (entry: typeof word | undefined) => !!entry && !entry.arabic && /^\p{Lu}\p{Ll}/u.test(entry.raw) && entry.folded.length >= 3;
      const sex = capital(word) ? laSex(word.folded) : undefined;
      let last = -1;
      if (sex) { add(word.raw, "given", sex); last = i; }
      else if (LA_TITLES.has(word.folded) && capital(next) && /^\.?[ \t]+$/.test(gap(i, i + 1)) && !LA_STOP.has(next.folded)) { add(next.raw, "given", laSex(next.folded) ?? LA_TITLES.get(word.folded)!, !!laSex(next.folded)); last = i + 1; }
      else if (word.folded === "is" && words[i - 1]?.folded === "name" && capital(next) && !LA_STOP.has(next.folded)) { add(next.raw, "given", laSex(next.folded) ?? "male", !!laSex(next.folded)); last = i + 1; }
      if (last >= 0) {
        named = true;
        // The rest of the name: particles and capitalized words written straight after it.
        let article = false;
        for (let j = last + 1, taken = 0; j < words.length && taken < 3; j++) {
          const tail = words[j];
          if (tail.arabic || !/^[ \t\-]+$/.test(gap(j - 1, j))) break;
          if (LA_PARTICLES.has(tail.folded)) { article = tail.folded === "al" || tail.folded === "el"; last = j; continue; }
          if (!capital(tail) || LA_STOP.has(tail.folded)) break;
          add(tail.raw, article || !laSex(tail.folded) ? "family" : "given", "male", sex !== undefined || article || !!laSex(tail.folded));
          article = false; last = j; taken++;
        }
        i = last;
      }
    }
    afterName = named;
  }
}

interface Matcher { regex: RegExp; replace(match: string, groups: Record<string, string | undefined>): string }
const matchers = new WeakMap<SurrogateState, { revision: number; forward?: Matcher; back?: Matcher; ids?: RegExp }>();
function cache(state: SurrogateState) {
  let entry = matchers.get(state);
  if (!entry || entry.revision !== state.revision) matchers.set(state, entry = { revision: state.revision });
  return entry;
}
const cased = (model: string, value: string) => model.length > 1 && model === model.toUpperCase() && model !== model.toLowerCase() ? value.toUpperCase() : value;

function buildMatcher(items: Array<{ script: Script; kind: Kind; parts: string[]; value(script: Script): { text: string; script: Script } }>): Matcher | undefined {
  if (!items.length) return undefined;
  const sorted = [...items].sort((a, b) => b.parts.join(" ").length - a.parts.join(" ").length);
  const sources = sorted.map((item) => patternOf(item.script, item.kind, item.parts));
  const split = sources.map((source) => new RegExp(`^(${source.prefix})(${source.core})$`, "iu"));
  const regex = new RegExp(`${NOT_WORD_BEFORE}(?:${sources.map((source, index) => `(?<u${index}>${source.prefix}${source.core})`).join("|")})${NOT_WORD_AFTER}`, "giu");
  return {
    regex,
    replace(match, groups) {
      const index = sorted.findIndex((_, position) => groups[`u${position}`] !== undefined);
      const item = sorted[index];
      const [, prefix = "", core = match] = split[index].exec(match) ?? [];
      // A transliteration variant counts only when it is written as a name; the exact spelling counts in any case.
      // A short one in lower case is left alone: it is far more often an ordinary word ("same", "timer").
      const exact = foldName(core).replace(/[\s\-]+/g, "") === item.parts.join("");
      if (item.script === "la" && !exact && item.parts.length === 1 && item.parts[0].length < 6 && !/^\p{Lu}/u.test(core)) return match;
      const value = item.value(item.script);
      return (value.script === item.script ? prefix : "") + cased(core, value.text);
    },
  };
}

function forward(state: SurrogateState) {
  const entry = cache(state);
  return entry.forward ??= buildMatcher(state.units.map((unit) => ({
    script: unit.script, kind: unit.kind, parts: unit.parts,
    value: (script) => { const surrogate = state.entries[unit.entry]; return { text: script === "ar" ? surrogate.ar : surrogate.la, script: script === "ar" && !isArabic(surrogate.ar) ? "la" : script }; },
  })));
}
function back(state: SurrogateState) {
  const entry = cache(state);
  return entry.back ??= buildMatcher(state.entries.flatMap((surrogate) => (["ar", "la"] as const).filter((script) => script === "la" || isArabic(surrogate.ar)).map((script) => ({
    script, kind: surrogate.kind, parts: [foldName(script === "ar" ? surrogate.ar : surrogate.la)],
    value: () => script === "ar"
      ? (surrogate.origAr !== undefined ? { text: surrogate.origAr, script: "ar" as Script } : { text: surrogate.origLa!, script: "la" as Script })
      : (surrogate.origLa !== undefined ? { text: surrogate.origLa, script: "la" as Script } : { text: surrogate.origAr!, script: "ar" as Script }),
  }))));
}
const apply = (matcher: Matcher | undefined, text: string) => matcher
  ? text.replace(matcher.regex, (...args) => matcher.replace(args[0] as string, args[args.length - 1] as Record<string, string | undefined>)) : text;

// ---- Identifiers -------------------------------------------------------------------------

function token(state: SurrogateState, kind: TokenKind, original: string) {
  // Keyed on the text exactly as written, so the way back returns it character for character.
  const key = `${kind}:${original}`;
  let value = state.tokenFor.get(key);
  if (!value) {
    value = `${kind}-${letters(state.counters[kind] = (state.counters[kind] ?? 0) + 1)}`;
    state.tokenFor.set(key, value);
    state.tokens.set(value, original);
  }
  return value;
}
const digitClass = (digit: string) => `[${digit}${String.fromCharCode(0x660 + Number(digit))}${String.fromCharCode(0x6f0 + Number(digit))}]`;
function knownIdPattern(state: SurrogateState) {
  const entry = cache(state);
  if (entry.ids !== undefined || !state.knownIds.size) return entry.ids;
  const sources = [...state.knownIds].sort((a, b) => b.length - a.length).map((id) => {
    const digits = id.replace(/[\s\-().+]/g, "");
    // A number is found however it is grouped, and a phone number with or without its country or trunk prefix.
    if (/^\d{6,}$/.test(digits)) {
      const national = digits.length >= 11 ? digits.replace(/^(?:00)?966/, "") : digits.replace(/^0(?=5\d{8}$)/, "");
      return `(?:(?:\\+|00)?${D}{0,3}[\\s\\-().]*0?)?${[...national].map(digitClass).join("[\\s\\-().]?")}`;
    }
    return [...id].map((char) => /\d/.test(char) ? digitClass(char) : char === " " ? "\\s+" : escape(char)).join("");
  });
  return entry.ids = new RegExp(`(?<![\\p{L}\\p{N}])(?:${sources.join("|")})(?![\\p{L}\\p{N}])`, "giu");
}

const RECORD_TYPES = "Patient|Encounter|Practitioner|PractitionerRole|RelatedPerson|Person|Organization|Location|Observation|Condition|MedicationRequest|MedicationStatement|AllergyIntolerance|DocumentReference|DiagnosticReport|ServiceRequest|Coverage|Appointment|Procedure";
const ID_CUE = new RegExp(`(?<![\\p{L}])((?:MRN|medical record(?: number| no\\.?)?|file (?:number|no\\.?)|national id|iqama(?: number| no\\.?)?|id(?: number| no\\.?)?|insurance(?: number| no\\.?| id)?|policy(?: number| no\\.?)?|passport(?: number| no\\.?)?|`
  + `رقم الملف|رقم الهوية|الهوية الوطنية|رقم الإقامة|رقم الاقامة|الإقامة|الاقامة|السجل المدني|رقم السجل|رقم التأمين|رقم التامين|رقم الجوال|رقم الهاتف|رقم البوليصة|رقم الجواز)\\s*(?:[:#=\\-]|is\\b|هو|رقم)?\\s*)([A-Za-z0-9٠-٩۰-۹][A-Za-z0-9٠-٩۰-۹\\-\\/]{2,30})`, "giu");
const ID_PASSES: Array<[RegExp, TokenKind]> = [
  [/(?:\bhttps?:\/\/|\bwww\.)[^\s"'<>]*[^\s"'<>.,;:!?)\]]/giu, "URL"],
  [/[\p{L}\p{N}._%+\-]+@[\p{L}\p{N}.\-]+\.\p{L}{2,}/gu, "EMAIL"],
  [new RegExp(`\\b(?:${RECORD_TYPES})\\/[A-Za-z0-9\\-.]{1,64}`, "g"), "ID"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "ID"],
  [new RegExp(`(?<![\\p{L}\\p{N}])(?:\\+|00)${D}(?:[\\s\\-().]?${D}){7,14}(?!${D})`, "gu"), "PHONE"],
  [new RegExp(`(?<![\\p{L}\\p{N}.,:\\/\\-])0${D}{1,2}[\\s\\-]${D}{3}[\\s\\-]${D}{4}(?![\\p{L}\\p{N}])`, "gu"), "PHONE"],
];
// Eight digits or more in a row is a record, identity or phone number, never a clinical value.
const LONG_NUMBER = new RegExp(`(?<![\\p{L}\\p{N}.,:\\/\\-])${D}{8,}(?![\\p{L}\\p{N}]|[.,:\\/\\-]${D})`, "gu");

function hideIdentifiers(state: SurrogateState, text: string) {
  // Text that already looks like one of our tokens is hidden too, so the way back cannot mistake it.
  let out = text.replace(TOKEN, (match) => token(state, "ID", match)).replace(DATE_TOKEN, (match) => token(state, "DATE", match));
  out = out.replace(ID_PASSES[0][0], (match) => token(state, "URL", match)).replace(ID_PASSES[1][0], (match) => token(state, "EMAIL", match));
  const known = knownIdPattern(state);
  if (known) out = out.replace(known, (match) => token(state, /^[+0-9٠-٩۰-۹\s\-().]+$/u.test(match) && /^(?:\+|00|05|٠٥)/u.test(match.trim()) ? "PHONE" : "ID", match));
  for (const [regex, kind] of ID_PASSES.slice(2)) out = out.replace(regex, (match) => token(state, kind, match));
  out = out.replace(ID_CUE, (match, cue: string, value: string) => /[0-9٠-٩۰-۹]/u.test(value) ? cue + token(state, "ID", value) : match);
  return out.replace(LONG_NUMBER, (match) => token(state, /^(?:05|9665)/.test(asciiDigits(match)) ? "PHONE" : "ID", match));
}

// ---- Dates -------------------------------------------------------------------------------

const MONTHS: Record<string, number> = { january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
  "يناير": 1, "فبراير": 2, "مارس": 3, "ابريل": 4, "مايو": 5, "يونيو": 6, "يوليو": 7, "اغسطس": 8, "سبتمبر": 9, "اكتوبر": 10, "نوفمبر": 11, "ديسمبر": 12 };
const EN_MONTH = "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec";
const AR_MONTH = "يناير|فبراير|مارس|[أا]بريل|مايو|يونيو|يوليو|[أا]غسطس|سبتمبر|[أا]كتوبر|نوفمبر|ديسمبر";
const TIME = `(?:[T ](${D}{2}:${D}{2}(?::${D}{2})?)(?:\\.${D}+)?(?:Z|[+-]${D}{2}:?${D}{2})?)?`;
const DATE_PASSES: Array<[RegExp, (groups: string[]) => { y?: string; m: string; d: string; time?: string }]> = [
  [new RegExp(`(?<![\\p{L}\\p{N}\\-\\/.])(${D}{4})-(${D}{2})-(${D}{2})${TIME}(?![\\p{N}])`, "gu"), ([y, m, d, time]) => ({ y, m, d, time })],
  [new RegExp(`(?<![\\p{L}\\p{N}\\-\\/.])(${D}{4})[\\/.](${D}{1,2})[\\/.](${D}{1,2})(?![\\p{N}\\/.])`, "gu"), ([y, m, d]) => ({ y, m, d })],
  [new RegExp(`(?<![\\p{L}\\p{N}\\-\\/.])(${D}{1,2})[\\/.\\-](${D}{1,2})[\\/.\\-](${D}{4})(?![\\p{N}\\/.\\-])`, "gu"), ([d, m, y]) => ({ y, m, d })],
  [new RegExp(`(?<![\\p{L}\\p{N}\\/.])(${D}{1,2})(?:st|nd|rd|th)?[ \\-]+(?:of )?(${EN_MONTH})(?![\\p{L}])(?:,?[ \\-]+(${D}{4}))?(?![\\p{N}])`, "gu"), ([d, m, y]) => ({ y, m, d })],
  [new RegExp(`(?<![\\p{L}])(${EN_MONTH}) (${D}{1,2})(?:st|nd|rd|th)?(?![\\p{L}\\p{N}\\/.:])(?:,? (${D}{4}))?(?![\\p{N}])`, "gu"), ([m, d, y]) => ({ y, m, d })],
  [new RegExp(`(?<![\\p{L}\\p{N}\\/.])(${D}{1,2})\\s+(?:من\\s+)?(?:شهر\\s+)?(${AR_MONTH})(?![\\p{L}])(?:\\s+(?:من\\s+)?(?:عام\\s+|سنة\\s+)?(${D}{4}))?(?![\\p{N}])`, "gu"), ([d, m, y]) => ({ y, m, d })],
];

function hideDates(state: SurrogateState, text: string) {
  const anchor = Date.parse(`${state.anchor}T00:00:00Z`);
  let out = text;
  for (const [regex, read] of DATE_PASSES) {
    out = out.replace(regex, (match, ...groups: string[]) => {
      const parts = read(groups.slice(0, 4).map((group) => typeof group === "string" ? asciiDigits(group) : group));
      let month = /^\d+$/.test(parts.m) ? Number(parts.m) : MONTHS[foldName(parts.m)];
      let day = Number(parts.d);
      if (month > 12 && day <= 12) [month, day] = [day, month];
      if (!month || month > 12 || day < 1 || day > 31) return match;
      let year = parts.y ? Number(parts.y) : NaN;
      // A Hijri year cannot be turned into an offset here; the date is hidden whole.
      if (year >= 1300 && year <= 1500) return token(state, "DATE", match);
      if (parts.y && (year < 1900 || year > 2100)) return match;
      if (!parts.y) {
        // No year was written: the one that puts the date closest to the visit.
        const base = new Date(anchor).getUTCFullYear();
        year = [base - 1, base, base + 1].sort((a, b) => Math.abs(Date.UTC(a, month - 1, day) - anchor) - Math.abs(Date.UTC(b, month - 1, day) - anchor))[0];
      }
      const time = Date.UTC(year, month - 1, day);
      if (new Date(time).getUTCDate() !== day) return match;
      const offset = Math.round((time - anchor) / DAY_MS);
      const value = `T${offset < 0 ? "-" : "+"}${Math.abs(offset)}d${parts.time ? ` ${parts.time}` : ""}`;
      if (!state.dateText.has(value)) state.dateText.set(value, match);
      return value;
    });
  }
  return out;
}
function restoreDates(state: SurrogateState, text: string) {
  const anchor = Date.parse(`${state.anchor}T00:00:00Z`);
  return text.replace(DATE_TOKEN, (match, offset: string, time?: string) => {
    const written = state.dateText.get(match);
    if (written) return written;
    const date = new Date(anchor + Number(offset) * DAY_MS);
    if (!Number.isFinite(date.getTime())) return match;
    return state.dateText.get(`T${offset}d`) ?? date.toISOString().slice(0, 10) + (time ? ` ${time}` : "");
  });
}

// ---- Whole messages ----------------------------------------------------------------------

function mapStrings(value: unknown, change: (text: string) => string): unknown {
  if (typeof value === "string") return FACT_ID.test(value) ? value : change(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, change));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, change)]));
  return value;
}
/** A message is one JSON object in this product; its string values are changed and its keys, numbers and structure are not. Anything else is treated as plain text. */
function mapDocument(content: string, change: (text: string) => string) {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return change(content); }
  return parsed && typeof parsed === "object" ? JSON.stringify(mapStrings(parsed, change)) : change(content);
}

/** What leaves for the model, for every message of one request. Names found in one message are replaced in all of them. */
export function hideDocuments(state: SurrogateState, contents: readonly string[], identity?: ChartIdentity) {
  // A stand-in is not chosen from the names this text itself uses, so a real person is not mistaken for one.
  state.avoid = new Set(contents.flatMap((content) => foldName(content).match(/[\p{L}\p{M}]{3,}/gu) ?? []));
  if (identity) registerIdentity(state, identity);
  for (const content of contents) mapDocument(content, (text) => { detectNames(state, text); return text; });
  return contents.map((content) => mapDocument(content, (text) => apply(forward(state), hideDates(state, hideIdentifiers(state, text)))));
}
export const hideText = (state: SurrogateState, text: string) => hideDocuments(state, [text])[0];

/** The model's answer with every stand-in replaced by what it stood for. */
export function restoreDocument(state: SurrogateState, content: string) {
  return mapDocument(content, (text) => restoreDates(state, apply(back(state), text)).replace(TOKEN, (match) => state.tokens.get(match) ?? match));
}

/**
 * Independent check of what is about to be sent: a name or identifier the chart supplied that is
 * still there, by plain comparison and not by the patterns that did the replacing.
 * Returns how many were found; the caller sends nothing unless it is zero.
 */
export function remainingIdentifiers(state: SurrogateState, outbound: string) {
  const plain = asciiDigits(outbound);
  const words = ` ${foldName(plain).replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  const compact = plain.toLowerCase().replace(/[\s\-().]/g, "");
  const spaced = ` ${plain.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  const standIns = new Set(state.entries.flatMap((entry) => [foldName(entry.ar), foldName(entry.la)]));
  let found = 0;
  for (const unit of state.units) {
    const name = unit.parts.join(" ");
    if (!unit.known || standIns.has(name)) continue;
    if (words.includes(` ${name} `) || (unit.script === "ar" && unit.kind === "family" && words.includes(` ال${name} `))) found++;
  }
  for (const id of state.knownIds) {
    const digits = id.replace(/[\s\-().+]/g, "");
    if (/^\d{6,}$/.test(digits) ? compact.includes(digits) : spaced.includes(` ${id.replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `)) found++;
  }
  return found;
}
