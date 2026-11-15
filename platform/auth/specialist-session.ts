import "server-only";
import { createHash, randomInt } from "node:crypto";
import { cookies } from "next/headers";
import { z } from "zod";
import { database } from "@/platform/persistence/database";
import { getEnv, specialistMap, type SpecialistEntry } from "@/platform/tenants/env";
import { dataClassificationSchema } from "@/shared/schemas";
import type { DataClassification } from "@/shared/contracts";
import { AuthError, cookieOptions, requireSameOrigin } from "./session";
import { readHandle, sessionCookie, storeHandle } from "./session-store";

/**
 * A receiving specialist's session. It is not a clinician session: it carries no patient, no
 * encounter and no EHR token, and the only thing it can reach is the inbox of its own service.
 */
export interface SpecialistContext {
  specialistId: string;
  tenantId: string;
  providerId: string;
  displayName: string;
  scopes: readonly string[];
  expiresAt: number;
  authorization: "active";
  dataClassification: DataClassification;
}
const specialistSchema = z.object({ specialist: z.object({
  specialistId: z.uuid(), tenantId: z.string().min(1), providerId: z.string().min(1), displayName: z.string().min(1), scopes: z.array(z.string()),
  expiresAt: z.number().int(), authorization: z.literal("active"), dataClassification: dataClassificationSchema,
}).strict() }).strict();

export async function saveSpecialistSession(entry: SpecialistEntry) {
  const env = getEnv();
  const expiresAt = Date.now() + env.SPECIALIST_SESSION_MINUTES * 60_000;
  const specialist: SpecialistContext = {
    specialistId: entry.specialistId, tenantId: env.TENANT_ID, providerId: entry.providerId, displayName: entry.displayName,
    scopes: ["inbox:read", "inbox:respond"], expiresAt, authorization: "active", dataClassification: env.CLINICAL_DATA_MODE,
  };
  const jar = await cookies();
  // Signing in replaces whatever session this browser held, clinician or specialist.
  await readHandle(jar.get(sessionCookie)?.value, "session", true);
  jar.set(sessionCookie, await storeHandle("session", { specialist }, expiresAt), cookieOptions(Math.floor((expiresAt - Date.now()) / 1000)));
}

export async function requireSpecialist(options: { navigation?: boolean } = {}): Promise<SpecialistContext> {
  if (!options.navigation) await requireSameOrigin();
  const env = getEnv();
  const jar = await cookies();
  const stored = specialistSchema.safeParse(await readHandle(jar.get(sessionCookie)?.value, "session"));
  // The session must still match the tenant and its classification, and the specialist must still be registered for that service.
  if (stored.success && stored.data.specialist.expiresAt > Date.now() && stored.data.specialist.tenantId === env.TENANT_ID &&
      stored.data.specialist.dataClassification === env.CLINICAL_DATA_MODE &&
      specialistMap(env).some((entry) => entry.specialistId === stored.data.specialist.specialistId && entry.providerId === stored.data.specialist.providerId)) {
    return stored.data.specialist;
  }
  throw new AuthError("unauthenticated", "Sign in to the specialist inbox");
}

// --- One-time sign-in codes by email, for a specialist without access to the EHR -----------------
const CODE_MINUTES = 10;
const CODES_PER_QUARTER_HOUR = 3;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const codeKey = (tenant: string, email: string, code: string) => createHash("sha256").update(`specialist-code:${tenant}:${email}:${code}`).digest("hex");
const emailKey = (email: string) => createHash("sha256").update(`specialist-email:${email}`).digest("hex");

export interface EmailSender { send(message: { to: string; subject: string; text: string }): Promise<void> }
/** Development only: the message is printed, never sent. Refused in production by the configuration check. */
export const consoleEmailSender: EmailSender = {
  async send(message) { console.info(`[email, not sent] to=${message.to} subject="${message.subject}"\n${message.text}`); },
};

/**
 * Sends a one-time code to a registered specialist's address. The message contains the code and a
 * link, and nothing about any patient or request. The answer is the same whether or not the
 * address is registered, and at most three codes are issued per address per quarter hour.
 */
export async function requestSpecialistCode(rawEmail: string, origin: string, sender: EmailSender | undefined) {
  const env = getEnv();
  const email = rawEmail.trim().toLowerCase();
  const entry = specialistMap(env).find((candidate) => candidate.email?.toLowerCase() === email);
  if (!entry || !sender) return;
  const sql = database();
  const [{ count }] = await sql`select count(*)::int as count from stetholink_private.browser_sessions
    where tenant_id = ${env.TENANT_ID} and kind = 'launch' and payload->>'specialistCodeFor' = ${emailKey(email)} and expires_at > now() + ${`${CODE_MINUTES - 15} minutes`}::interval`;
  if (count >= CODES_PER_QUARTER_HOUR) return;
  const code = Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  await sql`insert into stetholink_private.browser_sessions (handle_hash, kind, tenant_id, payload, expires_at)
    values (${codeKey(env.TENANT_ID, email, code)}, 'launch', ${env.TENANT_ID}, ${JSON.stringify({ specialistCodeFor: emailKey(email), specialistId: entry.specialistId })}::text::jsonb, now() + ${`${CODE_MINUTES} minutes`}::interval)`;
  await sender.send({ to: entry.email!, subject: "Your StethoLink sign-in code",
    text: `Your one-time code for the StethoLink specialist inbox is ${code}. It works once and expires in ${CODE_MINUTES} minutes.\nOpen ${origin}/inbox and enter it. If you did not ask for it, ignore this message.` });
}

/** Exchanges a code for an inbox session. A code works once; a wrong one changes nothing. */
export async function redeemSpecialistCode(rawEmail: string, rawCode: string) {
  const env = getEnv();
  const email = rawEmail.trim().toLowerCase();
  const code = rawCode.trim().toUpperCase();
  if (!/^[A-Z2-9]{10}$/.test(code)) throw new AuthError("unauthenticated", "The code is not valid or has expired");
  const [row] = await database()`delete from stetholink_private.browser_sessions where handle_hash = ${codeKey(env.TENANT_ID, email, code)} and kind = 'launch'
    and tenant_id = ${env.TENANT_ID} and expires_at > now() returning payload`;
  const entry = row && specialistMap(env).find((candidate) => candidate.specialistId === row.payload?.specialistId && candidate.email?.toLowerCase() === email);
  if (!entry) throw new AuthError("unauthenticated", "The code is not valid or has expired");
  await saveSpecialistSession(entry);
}
