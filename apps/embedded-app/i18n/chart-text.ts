import type { ClinicalFact } from "@/shared/contracts";
import type { Locale, Messages } from "./messages";

/** What a chart fact says, as the clinician reads it: its value and unit, "documented" for a yes/no finding, or why it is not available. */
export function factValue(fact: ClinicalFact, chart: Messages["chart"]): string {
  if (fact.status === "unknown") return chart.unavailable[fact.reason] ?? chart.notAvailable;
  if (typeof fact.value === "boolean") return chart.documented;
  return `${String(fact.value)}${fact.unit ? ` ${fact.unit}` : ""}`;
}

/**
 * Texts about the chart that StethoLink's own connector writes in English (the labels of the facts it builds,
 * the notes about what it could not load, a patient's age). They are product text, so in Arabic they are
 * translated here; anything else, above all what the EHR itself wrote, is returned unchanged.
 * The patterns are the sentences of `integrations/fhir/facts.ts` and `core/consultation/demographics.ts`;
 * `tests/frontend/chart-text.test.ts` pins them, so a changed sentence there fails a test here.
 */
const NOUN: Record<string, string> = {
  "Allergies": "الحساسية", "Active problems": "المشكلات النشطة", "Active medication orders": "أوامر الأدوية النشطة",
  "Vital signs": "العلامات الحيوية", "Laboratory results": "نتائج المختبر",
};
const LOWER_NOUN: Record<string, string> = {
  "allergies": "الحساسية", "active problems": "المشكلات النشطة", "active medication orders": "أوامر الأدوية النشطة", "vital signs": "العلامات الحيوية",
  "laboratory results": "نتائج المختبر", "allergy records": "سجلات الحساسية", "problem records": "سجلات المشكلات", "medication orders": "أوامر الأدوية",
};
const days = (n: string) => `خلال آخر ${n} يومًا`;

/** The label of a chart fact. */
export function factLabel(label: string, locale: Locale): string {
  if (locale !== "ar") return label;
  const window = /^(Vital signs|Laboratory results) in the last (\d+) days$/.exec(label);
  if (window) return `${NOUN[window[1]]} ${days(window[2])}`;
  const plain = /^(Allergies|Active problems|Active medication orders|Vital signs|Laboratory results)( \(could not be loaded from the EHR\))?$/.exec(label);
  if (plain) return `${NOUN[plain[1]]}${plain[2] ? " (تعذّر تحميلها من النظام الطبي)" : ""}`;
  return label;
}

/** A note about what the connector could not load or left out. */
export function chartNote(note: string, locale: Locale): string {
  if (locale !== "ar") return note;
  let m: RegExpExecArray | null;
  if ((m = /^(Allergies|Active problems|Active medication orders|Vital signs|Laboratory results) could not be loaded from the EHR\. Check them in the chart\.$/.exec(note))) {
    return `تعذّر تحميل ${NOUN[m[1]]} من النظام الطبي. راجعها في الملف.`;
  }
  if ((m = /^The EHR holds more (.+) than StethoLink loads at once; the first (\d+) records were read\. Check the chart for the rest\.$/.exec(note)) && LOWER_NOUN[m[1]]) {
    return `يحتوي النظام الطبي على أكثر مما يحمّله StethoLink دفعة واحدة من ${LOWER_NOUN[m[1]]}؛ قُرئت أول ${m[2]} من السجلات. راجع الملف لبقيتها.`;
  }
  if ((m = /^(\d+) active medication orders? (?:has|have) no readable medication name and (?:is|are) not listed\. Check the medication list in the chart\.$/.exec(note))) {
    return `${m[1]} من أوامر الأدوية النشطة بلا اسم دواء مقروء، ولذلك لم تُدرج. راجع قائمة الأدوية في الملف.`;
  }
  if ((m = /^(\d+) (vital signs|laboratory results) records? (?:has|have) no readable name or value and (?:is|are) not listed\.$/.exec(note))) {
    return `${m[1]} من سجلات ${LOWER_NOUN[m[2]]} بلا اسم أو قيمة مقروءة، ولذلك لم تُدرج.`;
  }
  if ((m = /^Loaded from the EHR: the latest value of each laboratory test from the last (\d+) days and of each vital sign from the last (\d+) days\. Older results are not included\.$/.exec(note))) {
    return `حُمّلت من النظام الطبي: آخر قيمة لكل فحص مختبري ${days(m[1])}، ولكل علامة حيوية ${days(m[2])}. لا تُضمَّن النتائج الأقدم.`;
  }
  if ((m = /^Only the (\d+) most recent (.+) are included here; (\d+) more (?:is|are) in the chart\.$/.exec(note)) && LOWER_NOUN[m[2]]) {
    return `أُدرج هنا أحدث ${m[1]} من ${LOWER_NOUN[m[2]]} فقط؛ وفي الملف ${m[3]} أخرى.`;
  }
  if ((m = /^(\d+) chart items? (?:has|have) no recorded date in the EHR; the date shown for (?:it|them) is the day the chart was loaded\.$/.exec(note))) {
    return `${m[1]} من عناصر الملف بلا تاريخ مسجَّل في النظام الطبي؛ والتاريخ المعروض لها هو يوم تحميل الملف.`;
  }
  return note;
}

/** The age text of a consultation's patient ("58 years", "90 years or older", "3 months", "12 days"). */
export function ageText(age: string, locale: Locale): string {
  if (locale !== "ar") return age;
  let m: RegExpExecArray | null;
  if (age === "not recorded") return "غير مسجَّل";
  if (age === "90 years or older") return "90 سنة فأكثر";
  if ((m = /^(\d+) years$/.exec(age))) return `${m[1]} سنة`;
  if ((m = /^(\d+) months?$/.exec(age))) return `${m[1]} شهرًا`;
  if ((m = /^(\d+) days?$/.exec(age))) return `${m[1]} يومًا`;
  return age;
}

const REASON: Record<string, string> = { "not recorded": "غير مسجَّل", "not provided": "لم يُقدَّم", "not performed": "لم يُجرَ", "result pending": "النتيجة قيد الانتظار" };

/** A line of the missing-information list of a draft: a fact that is not available, a chart note, or the core's fixed sentence. */
export function missingLine(text: string, locale: Locale): string {
  if (locale !== "ar") return text;
  const m = /^(.+): (not recorded|not provided|not performed|result pending)$/.exec(text);
  if (m) return `${factLabel(m[1], locale)}: ${REASON[m[2]]}`;
  if (text === "The chart records no item as unavailable. This does not mean the record is complete.") return "لا يسجّل الملف أي عنصر على أنه غير متاح. وهذا لا يعني أن السجل كامل.";
  return chartNote(text, locale);
}

/**
 * The reason the EHR writer gives when an item could not be written to the chart (`integrations/fhir/writer.ts`). Product text, so it is
 * translated; the FHIR resource name inside it stays as written. `tests/frontend/chart-text.test.ts` drives the real writer into each case.
 */
export function writeFailure(text: string, locale: Locale): string {
  if (locale !== "ar") return text;
  let m: RegExpExecArray | null;
  if (text === "The item has no valid key") return "ليس لهذا العنصر مفتاح صالح";
  if ((m = /^The EHR did not give StethoLink permission to create (\w+)$/.exec(text))) return `لم يمنح النظام الطبي StethoLink إذنًا بإنشاء سجل من نوع ${m[1]}`;
  if ((m = /^The EHR does not accept new (\w+) records from applications$/.exec(text))) return `لا يقبل النظام الطبي من التطبيقات سجلات جديدة من نوع ${m[1]}`;
  if (text === "The EHR could not be reached. Nothing was written") return "تعذّر الوصول إلى النظام الطبي. لم يُكتب شيء";
  if (text === "The EHR refused the write for this session") return "رفض النظام الطبي الكتابة لهذه الجلسة";
  if (text === "The EHR already holds more than one record with this key") return "يحتفظ النظام الطبي بأكثر من سجل بهذا المفتاح";
  if ((m = /^The EHR did not accept the record \(status (\d+)\)$/.exec(text))) return `لم يقبل النظام الطبي السجل (الحالة ${m[1]})`;
  if (text === "The EHR did not return the identifier of the record") return "لم يُرجع النظام الطبي معرّف السجل";
  return text;
}

/** A fixed note the core adds to the plan of a draft. */
export function planNote(note: string, locale: Locale): string {
  if (locale === "ar" && note === "Physician review required: check each statement against its source before deciding.") return "يلزم أن يراجع الطبيب: تحقق من كل عبارة مقابل مصدرها قبل اتخاذ القرار.";
  return note;
}
