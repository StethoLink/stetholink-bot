import type { ChartIdentity } from "@/core/privacy/ports";

/**
 * Fictional people for the de-identification tests. Nobody here exists: the names are common
 * ones put together for the tests, and every number is made up (the phone numbers use an
 * unassigned range, the identity and record numbers are arbitrary digits).
 */
export const FICTIONAL_VISIT_START = "2026-03-10T07:30:00.000Z";

export const fictionalIdentity: ChartIdentity = {
  anchorDate: FICTIONAL_VISIT_START,
  people: [
    { role: "patient", sex: "male", names: [
      { given: ["محمد", "عبدالله"], family: "العتيبي" },
      { given: ["Mohammed", "Abdullah"], family: "Al-Otaibi" },
    ] },
    { role: "relative", sex: "female", names: [{ text: "نورة سعد العتيبي" }] },
    { role: "staff", sex: "female", names: [{ given: ["Huda"], family: "Alshehri" }] },
  ],
  identifiers: ["MRN-00482913", "1098765432", "+966 55 000 1234", "m.otaibi@example.invalid", "fic-pt-77", "fic-enc-204", "INS-7741-220"],
  addresses: ["Building 12, Fictional Street", "12345"],
};

/** Every spelling of the fictional identifiers that must never be seen in a model request. */
export const FORBIDDEN_IN_MODEL_REQUESTS = [
  // The patient, both scripts, with the spellings people actually type.
  "محمد", "محمّد", "مُحَمَّد", "العتيبي", "عتيبي", "عبدالله", "عبد الله", "Mohammed", "Muhammad", "Mohamed", "MOHAMMED", "Otaibi", "Al-Otaibi", "Alotaibi", "Abdullah",
  // The relative and the nurse.
  "نورة", "نوره", "Huda", "Alshehri",
  // People only the free text names.
  "زياد", "الدوسري", "Kowalski", "Tariq", "Hamdan",
  // Numbers and addresses.
  "00482913", "1098765432", "١٠٩٨٧٦٥٤٣٢", "550001234", "0550001234", "55 000 1234", "m.otaibi@example.invalid", "fic-pt-77", "fic-enc-204", "INS-7741-220",
  "Fictional Street", "https://ehr.example.invalid/patient/77", "2201456789", "0112223344", "nurse.station@example.invalid",
  // Calendar dates, however they were written.
  "2026-03-07", "2026-03-10", "07/03/2026", "2025-12-10", "3 March 2026", "٥ مارس", "5 مارس",
] as const;

/** What a physician might type, in both languages, around the same fictional patient. */
export const fictionalRequest = [
  "Prepare a cardiology consultation for Mohammed Al-Otaibi (MRN-00482913, national ID 1098765432), seen on 07/03/2026 by Dr. Kowalski.",
  "His wife نورة can be reached on 0550001234 or m.otaibi@example.invalid; chart at https://ehr.example.invalid/patient/77.",
  "Muhammad has had chest pain for 3 days, BP 150/95 mmHg, troponin 0.04 ng/mL, on amlodipine 5 mg once daily since 2025-12-10.",
].join(" ");

/** A fictional clinic visit in Saudi dialect, the way a transcript arrives: names with attached particles, a spoken phone number and a spoken date. */
export const fictionalTranscript = [
  { id: "s1", text: "السلام عليكم يا محمد، كيف حالك اليوم؟" },
  { id: "s2", text: "الحمد لله يا دكتور، عندي ألم في الصدر من ثلاثة أيام." },
  { id: "s3", text: "الضغط 150 على 95 والنبض 88، والحرارة 37.2." },
  { id: "s4", text: "الدكتور زياد الدوسري شافني يوم ٥ مارس وقال لي آخذ أملوديبين 5 ملغ مرة في اليوم." },
  { id: "s5", text: "ولمحمّد حساسية من البنسلين، وأخته نورة تتابع معه، ورقم الجوال ٠٥٥٠٠٠١٢٣٤." },
  { id: "s6", text: "رقم الهوية ١٠٩٨٧٦٥٤٣٢ ورقم الملف 2201456789، وهاتف القسم 011-222-3344." },
  { id: "s7", text: "نبدأ أسبرين 81 ملغ يوميا ونعيد تخطيط القلب بعد أسبوع." },
] as const;
