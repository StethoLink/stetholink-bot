/**
 * Numbers a source actually states, as digits. A figure in the note is accepted only if its
 * source contains it, whether the source wrote digits (Western or Arabic-Indic) or spoke the
 * number in Arabic words ("مية وخمسين على خمسة وتسعين" is 150 and 95).
 */
const WORDS: Record<string, number> = {
  صفر: 0, واحد: 1, وحده: 1, واحده: 1, اثنين: 2, اثنتين: 2, ثنتين: 2, ثلاث: 3, ثلاثه: 3, اربع: 4, اربعه: 4, خمس: 5, خمسه: 5, ست: 6, سته: 6,
  سبع: 7, سبعه: 7, ثمان: 8, ثماني: 8, ثمانيه: 8, تسع: 9, تسعه: 9, عشر: 10, عشره: 10,
  احدعش: 11, احدعشر: 11, اثنعش: 12, اثنعشر: 12, ثلاثطعش: 13, ثلاثطعشر: 13, اربعطعش: 14, اربعطعشر: 14, خمسطعش: 15, خمسطعشر: 15,
  ستطعش: 16, ستطعشر: 16, سبعطعش: 17, سبعطعشر: 17, ثمنطعش: 18, ثمنطعشر: 18, تسعطعش: 19, تسعطعشر: 19,
  عشرين: 20, ثلاثين: 30, اربعين: 40, خمسين: 50, ستين: 60, سبعين: 70, ثمانين: 80, تسعين: 90,
  ميه: 100, مايه: 100, ميتين: 200, مايتين: 200, ثلاثميه: 300, اربعميه: 400, خمسميه: 500, ستميه: 600, سبعميه: 700, ثمانميه: 800, تسعميه: 900,
  الف: 1000, الفين: 2000,
};
// Dual forms that state "two" of something, and "half".
const TWO = new Set(["مرتين", "يومين", "شهرين", "اسبوعين", "سنتين", "ساعتين", "حبتين", "بختين", "جرعتين", "دقيقتين", "ليلتين"]);

const normalizeArabic = (text: string) => text.normalize("NFKC")
  .replace(/[ً-ٰٟـ]/g, "").replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/ئ/g, "ي").replace(/ؤ/g, "و")
  .replace(/مئ(?=[هت])/g, "مي")
  .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit))).replace(/[٫]/g, ".").replace(/[٬]/g, "");

const trim = (value: number) => String(Number(value.toFixed(4)));

/** Every number the text states, as canonical digit strings ("150", "8.1"). */
export function statedNumbers(text: string): Set<string> {
  const found = new Set<string>();
  const normalized = normalizeArabic(text);
  for (const match of normalized.matchAll(/\d+(?:[.,]\d+)?/g)) found.add(trim(Number(match[0].replace(",", "."))));
  let total: number | undefined;
  let decimal: string | undefined;
  const flush = () => {
    if (total !== undefined) found.add(decimal !== undefined ? trim(Number(`${total}.${decimal}`)) : trim(total));
    total = undefined;
    decimal = undefined;
  };
  for (const raw of normalized.split(/[^\p{L}\p{N}]+/u)) {
    if (!raw) continue;
    if (TWO.has(raw) || TWO.has(raw.replace(/^و/, ""))) { flush(); found.add("2"); continue; }
    if (raw === "نص" || raw === "ونص" || raw === "نصف" || raw === "ونصف") { if (total !== undefined) { found.add(trim(total + 0.5)); } flush(); found.add("0.5"); found.add("30"); continue; }
    if (raw === "فاصله" && total !== undefined) { decimal = ""; continue; }
    const word = WORDS[raw] !== undefined ? raw : raw.startsWith("و") && WORDS[raw.slice(1)] !== undefined ? raw.slice(1) : undefined;
    if (word === undefined) { flush(); continue; }
    const value = WORDS[word];
    if (decimal !== undefined) { decimal += String(value); continue; }
    // "خمسة وتسعين" adds; a new number starts when the word is not joined by "و" and cannot extend the current one.
    if (total !== undefined && !raw.startsWith("و") && !(value === 1000 && total < 1000)) flush();
    total = total === undefined ? value : value === 1000 && total < 1000 && total > 0 ? total * 1000 : total + value;
  }
  flush();
  return found;
}

/** Digits written in a statement of the note. */
export function writtenNumbers(text: string): string[] {
  return [...normalizeArabic(text).matchAll(/\d+(?:[.,]\d+)?/g)].map((match) => trim(Number(match[0].replace(",", "."))));
}
