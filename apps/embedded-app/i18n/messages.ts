import type { ApiErrorCode } from "@/shared/contracts";
import { workAr, workEn } from "./work";

/**
 * Interface texts, English and Arabic. `ar` must have every key of `en` (the type enforces it).
 * Only the interface is translated. What the EHR or the model wrote (names, chart entries, drafts,
 * server explanations) is shown as written, with its own text direction.
 */
export const locales = ["en", "ar"] as const;
export type Locale = (typeof locales)[number];
export const localeCookie = "stetholink_locale";
export const isLocale = (value: unknown): value is Locale => value === "en" || value === "ar";
export const dirOf = (locale: Locale) => (locale === "ar" ? "rtl" : "ltr");

type VisitType = "inpatient" | "outpatient" | "emergency" | "virtual";
type VisitStatus = "planned" | "arrived" | "triaged" | "in_progress" | "on_leave" | "finished" | "cancelled";
type Sex = "male" | "female" | "other" | "unknown";
/** Parts of the chart the EHR can refuse, named for the clinician. */
export type ChartPart = "allergy" | "problem" | "medication" | "observation";

export const en = {
  appName: "StethoLink",
  description: "Clinical documentation and consultation assistant inside the patient chart",
  tabs: { label: "StethoLink sections", scribe: "Scribe", consultations: "Consultations", orders: "Orders", history: "History" },
  shortcuts: {
    title: "Keyboard shortcuts",
    items: [
      ["Alt + 1, 2, 3, 4", "Open Scribe, Consultations, Orders or History"],
      ["Ctrl + Enter", "Submit the text you are typing"],
      ["Esc", "Close a dialog"],
      ["?", "Show this list"],
    ] as [string, string][],
  },
  session: {
    endedTitle: "Your session has ended",
    endedText: "For safety, StethoLink closes after 15 minutes. Launch it again from the patient's chart in the EHR to continue. Anything you saved is kept.",
    noneTitle: "Open StethoLink from the patient chart",
    noneText: "StethoLink opens from the active patient chart in your EHR. If it was open, your session has ended: launch it again from the chart.",
  },
  readOnly: {
    title: "Reading only",
    text: "The chart is shown for reading. Writing notes and consultations from EHR data is not switched on for this hospital yet. Ask your StethoLink administrator.",
  },
  draftsOnly: "This session can prepare drafts only. Approving and sending need a verified physician session.",
  footer: "StethoLink prepares drafts. A clinician decides.",
  language: { label: "Interface language", other: "العربية" },
  common: { retry: "Retry", cancel: "Cancel", close: "Close", working: "Working…", dismiss: "Dismiss", reference: "Reference for your administrator" },
  data: { live: "Real patient data", synthetic: "Synthetic data", aiGenerated: "AI-generated" },
  progress: {
    resultHere: "The result will appear here",
    longer: "This is taking longer than usual. It can take up to two minutes.",
    usually: (seconds: number) => `Usually about ${seconds} seconds.`,
  },
  patient: {
    loading: "Loading patient",
    loadingContext: "Loading patient context…",
    contextLabel: "Patient context",
    sex: { male: "Male", female: "Female", other: "Other", unknown: "Sex not recorded" } as Record<Sex, string>,
    years: (years: number) => `${years} y`,
    born: (date: string) => `DOB ${date}`,
    visit: (type: string, status: string) => `${type} visit, ${status}`,
    visitType: { inpatient: "Inpatient", outpatient: "Outpatient", emergency: "Emergency", virtual: "Virtual" } as Record<VisitType, string>,
    visitStatus: { planned: "planned", arrived: "arrived", triaged: "triaged", in_progress: "in progress", on_leave: "on leave", finished: "finished", cancelled: "cancelled" } as Record<VisitStatus, string>,
    allergies: (count: number) => `Allergies: ${count}`,
    allergyStatusInChart: "Allergy status in chart",
    allergiesNotRecorded: "Allergies not recorded",
    allergiesNotLoaded: "Allergies not loaded",
    showChart: "Chart",
    hideChart: "Hide chart",
  },
  chart: {
    allergies: "Allergies",
    allergiesCount: (count: number) => `Allergies (${count})`,
    allergiesNone: "None recorded. Confirm with the patient before prescribing.",
    allergiesNotLoaded: "The EHR did not share the allergy list. Check allergies in the EHR before prescribing.",
    activeProblems: "Active problems",
    medications: "Medications",
    noneRecorded: "None recorded",
    record: (documented: number, unavailable: number) => `Chart record (${documented} documented${unavailable ? `, ${unavailable} not available` : ""})`,
    groups: { symptoms: "Symptoms", examination: "Examination", investigations: "Investigations", history: "History and problems", medications: "Medications and allergies" },
    unavailable: { not_recorded: "not recorded", not_provided: "not provided", not_performed: "not performed", pending: "result pending" } as Record<string, string>,
    notAvailable: "not available",
    documented: "documented",
    documentedAbsent: "documented as absent",
    notesLabel: "What was not loaded from the chart",
    notesTitle: "Not everything in the chart is shown here",
    notSharedTitle: "The EHR did not share part of the chart",
    notSharedText: (parts: string) => `Not loaded: ${parts}. StethoLink was not given access to these records, or the EHR refused the request. Check them in the EHR; drafts are written without them.`,
    notSharedAdmin: "To show them here, the EHR administrator must grant StethoLink read access to these records.",
    parts: { allergy: "allergies", problem: "active problems", medication: "medications", observation: "vital signs and results" } as Record<ChartPart, string>,
    encounterLabel: "Encounter",
    encounterHeading: (type: string, status: string) => `${type} encounter · ${status.charAt(0).toUpperCase()}${status.slice(1)}`,
    reason: "Reason",
    location: "Location",
    started: "Started",
    loadingEncounter: "Loading encounter…",
    loadEncounterError: "Could not load encounter details.",
    loadPatientError: "Could not load patient context.",
  },
  /** Shown in place of the server's English explanation when the interface is not in English. */
  errors: {
    invalid_request: "The request could not be processed.",
    unauthenticated: "Your session has ended. Launch StethoLink again from the patient's chart.",
    forbidden: "You do not have permission for this in StethoLink.",
    not_found: "This record was not found.",
    conflict: "This record changed elsewhere. Reload and try again.",
    safety_blocked: "This was stopped by a safety check.",
    unsupported_encounter: "This visit cannot be used. Open a visit in the patient's chart, then launch StethoLink again.",
    not_implemented: "This is not available.",
    provider_unavailable: "A service StethoLink depends on is not answering. Try again in a moment.",
    internal_error: "Something went wrong in StethoLink. Try again.",
  } as Record<ApiErrorCode, string>,
  launch: {
    title: "StethoLink could not open",
    visitTitle: "StethoLink needs an open visit",
    generic: "StethoLink could not confirm who you are or which chart is open.",
    visit: "Open a visit in the patient's chart, then launch StethoLink again.",
    again: "Launch StethoLink from the patient's chart again. If it keeps failing, give the reference below to your system administrator.",
    detail: "Details from the server",
  },
  work: workEn,
};
export type Messages = typeof en;

export const ar: Messages = {
  appName: "StethoLink",
  description: "مساعد التوثيق السريري وطلبات الاستشارة داخل ملف المريض",
  tabs: { label: "أقسام StethoLink", scribe: "المدوِّن", consultations: "الاستشارات", orders: "الأوامر", history: "السجل" },
  shortcuts: {
    title: "اختصارات لوحة المفاتيح",
    items: [
      ["Alt + 1, 2, 3, 4", "فتح المدوِّن أو الاستشارات أو الأوامر أو السجل"],
      ["Ctrl + Enter", "إرسال النص الذي تكتبه"],
      ["Esc", "إغلاق النافذة الحوارية"],
      ["?", "عرض هذه القائمة"],
    ],
  },
  session: {
    endedTitle: "انتهت جلستك",
    endedText: "حرصًا على الأمان يُغلق StethoLink بعد 15 دقيقة. شغِّله مرة أخرى من ملف المريض في النظام الطبي للمتابعة. كل ما حفظته باقٍ.",
    noneTitle: "افتح StethoLink من ملف المريض",
    noneText: "يُفتح StethoLink من ملف المريض المفتوح في النظام الطبي. إن كان مفتوحًا فقد انتهت جلستك: شغِّله مرة أخرى من الملف.",
  },
  readOnly: {
    title: "للقراءة فقط",
    text: "يُعرض الملف للقراءة. كتابة الملاحظات والاستشارات من بيانات النظام الطبي غير مفعّلة لهذا المستشفى بعد. راجع مسؤول StethoLink.",
  },
  draftsOnly: "هذه الجلسة تُعِدّ المسودات فقط. الاعتماد والإرسال يتطلبان جلسة طبيب موثَّقة.",
  footer: "StethoLink يُعِدّ المسودات، والقرار للطبيب.",
  language: { label: "لغة الواجهة", other: "English" },
  common: { retry: "أعد المحاولة", cancel: "إلغاء", close: "إغلاق", working: "جارٍ التنفيذ…", dismiss: "إخفاء", reference: "المرجع لمسؤول النظام" },
  data: { live: "بيانات مريض حقيقية", synthetic: "بيانات تجريبية", aiGenerated: "من إعداد الذكاء الاصطناعي" },
  progress: {
    resultHere: "ستظهر النتيجة هنا",
    longer: "يستغرق هذا أكثر من المعتاد. قد يصل إلى دقيقتين.",
    usually: (seconds) => `يستغرق عادةً نحو ${seconds} ثانية.`,
  },
  patient: {
    loading: "جارٍ تحميل بيانات المريض",
    loadingContext: "جارٍ تحميل ملف المريض…",
    contextLabel: "ملف المريض",
    sex: { male: "ذكر", female: "أنثى", other: "آخر", unknown: "الجنس غير مسجَّل" },
    years: (years) => `${years} سنة`,
    born: (date) => `تاريخ الميلاد ${date}`,
    visit: (type, status) => `زيارة ${type}، ${status}`,
    visitType: { inpatient: "تنويم", outpatient: "عيادة خارجية", emergency: "طوارئ", virtual: "عن بُعد" },
    visitStatus: { planned: "مجدولة", arrived: "حضر المريض", triaged: "بعد الفرز", in_progress: "جارية", on_leave: "في إجازة", finished: "منتهية", cancelled: "ملغاة" },
    allergies: (count) => `الحساسية: ${count}`,
    allergyStatusInChart: "حالة الحساسية في الملف",
    allergiesNotRecorded: "الحساسية غير مسجَّلة",
    allergiesNotLoaded: "الحساسية لم تُحمَّل",
    showChart: "الملف",
    hideChart: "إخفاء الملف",
  },
  chart: {
    allergies: "الحساسية",
    allergiesCount: (count) => `الحساسية (${count})`,
    allergiesNone: "لا شيء مسجَّل. تأكد من المريض قبل وصف أي دواء.",
    allergiesNotLoaded: "لم يشارك النظام الطبي قائمة الحساسية. راجع الحساسية في النظام الطبي قبل وصف أي دواء.",
    activeProblems: "المشكلات النشطة",
    medications: "الأدوية",
    noneRecorded: "لا شيء مسجَّل",
    record: (documented, unavailable) => `سجل الملف (${documented} موثَّق${unavailable ? `، ${unavailable} غير متاح` : ""})`,
    groups: { symptoms: "الأعراض", examination: "الفحص", investigations: "الفحوصات", history: "التاريخ المرضي والمشكلات", medications: "الأدوية والحساسية" },
    unavailable: { not_recorded: "غير مسجَّل", not_provided: "لم يُقدَّم", not_performed: "لم يُجرَ", pending: "النتيجة قيد الانتظار" },
    notAvailable: "غير متاح",
    documented: "موثَّق",
    documentedAbsent: "موثَّق أنه غير موجود",
    notesLabel: "ما لم يُحمَّل من الملف",
    notesTitle: "لا يُعرض هنا كل ما في الملف",
    notSharedTitle: "لم يشارك النظام الطبي جزءًا من الملف",
    notSharedText: (parts) => `لم يُحمَّل: ${parts}. لم يُمنح StethoLink صلاحية قراءة هذه السجلات، أو رفض النظام الطبي الطلب. راجعها في النظام الطبي؛ المسودات تُكتب من دونها.`,
    notSharedAdmin: "لعرضها هنا يجب أن يمنح مسؤول النظام الطبي StethoLink صلاحية قراءة هذه السجلات.",
    parts: { allergy: "الحساسية", problem: "المشكلات النشطة", medication: "الأدوية", observation: "العلامات الحيوية والنتائج" },
    encounterLabel: "الزيارة",
    encounterHeading: (type, status) => `زيارة ${type} · ${status}`,
    reason: "السبب",
    location: "المكان",
    started: "البداية",
    loadingEncounter: "جارٍ تحميل الزيارة…",
    loadEncounterError: "تعذّر تحميل تفاصيل الزيارة.",
    loadPatientError: "تعذّر تحميل ملف المريض.",
  },
  errors: {
    invalid_request: "تعذّر تنفيذ الطلب.",
    unauthenticated: "انتهت جلستك. شغِّل StethoLink مرة أخرى من ملف المريض.",
    forbidden: "ليست لديك صلاحية لهذا في StethoLink.",
    not_found: "لم يُعثر على هذا السجل.",
    conflict: "تغيّر هذا السجل من مكان آخر. أعد التحميل ثم حاول مرة أخرى.",
    safety_blocked: "أوقف فحصُ السلامة هذا الإجراء.",
    unsupported_encounter: "لا يمكن استخدام هذه الزيارة. افتح زيارة في ملف المريض ثم شغِّل StethoLink مرة أخرى.",
    not_implemented: "هذه الخاصية غير متاحة.",
    provider_unavailable: "خدمة يعتمد عليها StethoLink لا تستجيب. حاول بعد قليل.",
    internal_error: "حدث خطأ في StethoLink. حاول مرة أخرى.",
  },
  launch: {
    title: "تعذّر فتح StethoLink",
    visitTitle: "يحتاج StethoLink إلى زيارة مفتوحة",
    generic: "تعذّر على StethoLink التحقق من هويتك أو من الملف المفتوح.",
    visit: "افتح زيارة في ملف المريض ثم شغِّل StethoLink مرة أخرى.",
    again: "شغِّل StethoLink مرة أخرى من ملف المريض. إن تكرر الفشل فأعطِ المرجع أدناه لمسؤول النظام.",
    detail: "تفاصيل من الخادم",
  },
  work: workAr,
};

export const messages: Record<Locale, Messages> = { en, ar };
