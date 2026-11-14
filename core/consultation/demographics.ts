import type { PatientContext } from "@/shared/contracts";

/**
 * Age and administrative sex are part of every consultation: a specialist cannot weigh a
 * finding without them. Only these two are derived; the name, the birth date and chart
 * identifiers never leave the chart. Ages of 90 and over are reported as "90 years or older"
 * so that a very old age cannot single a patient out.
 */
export interface PatientDemographics {
  /** e.g. "67 years", "8 months", "12 days", "90 years or older"; null when no valid birth date is recorded. */
  age: string | null;
  sex: PatientContext["sex"];
}

const DAY_MS = 86_400_000;

/** Whole calendar units elapsed from the birth date to the reference instant (UTC). */
export function ageText(birthDate: string | undefined, at: Date): string | null {
  if (!birthDate || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) return null;
  const [year, month, day] = birthDate.split("-").map(Number);
  const born = Date.UTC(year, month - 1, day);
  const birth = new Date(born);
  if (birth.getUTCFullYear() !== year || birth.getUTCMonth() !== month - 1 || birth.getUTCDate() !== day) return null;
  const now = at.getTime();
  if (!Number.isFinite(now) || born > now) return null;
  let months = (at.getUTCFullYear() - year) * 12 + (at.getUTCMonth() - (month - 1));
  if (at.getUTCDate() < day) months--;
  const years = Math.floor(months / 12);
  if (years >= 90) return "90 years or older";
  if (years >= 2) return `${years} years`;
  if (months >= 1) return `${months} month${months === 1 ? "" : "s"}`;
  const days = Math.floor((now - born) / DAY_MS);
  return `${days} day${days === 1 ? "" : "s"}`;
}

export function patientDemographics(patient: Pick<PatientContext, "birthDate" | "sex">, at: Date = new Date()): PatientDemographics {
  return { age: ageText(patient.birthDate, at), sex: patient.sex };
}

const SEX_TEXT: Record<PatientContext["sex"], string> = { male: "Male", female: "Female", other: "Other", unknown: "Not recorded" };

/** Header lines of the consultation text, identical for every draft. */
export function demographicLines(demographics: PatientDemographics) {
  return [`Age: ${demographics.age ?? "Not recorded"}`, `Sex: ${SEX_TEXT[demographics.sex]}`];
}
