import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { database } from "@/platform/persistence/database";
import { getEnv } from "@/platform/tenants/env";

export const sessionCookie = "stetholink-session";
export const launchCookie = "stetholink-smart-launch";
type Kind = "session" | "launch";

const digest = (handle: string) => createHash("sha256").update(handle).digest("hex");
const valid = (handle: string | undefined): handle is string => !!handle && /^[\w-]{43}$/.test(handle);

/**
 * Sessions are encrypted before they are stored (AES-256-GCM, a fresh nonce per row), because a
 * session holds the clinician's EHR access token. The key comes from server configuration or a
 * secret manager, never from the database. Rotation: set a new SESSION_ENCRYPTION_KEY and move the
 * old one to SESSION_ENCRYPTION_KEYS_PREVIOUS; sessions last 15 minutes, so the old key can be
 * removed an hour later. Without a key (local development, synthetic data) sessions are stored as they are.
 */
const keyId = (key: Buffer) => createHash("sha256").update(key).digest("hex").slice(0, 8);
function keys() {
  const env = getEnv();
  const current = env.SESSION_ENCRYPTION_KEY ? Buffer.from(env.SESSION_ENCRYPTION_KEY, "base64") : undefined;
  const previous = (env.SESSION_ENCRYPTION_KEYS_PREVIOUS ?? "").split(",").map((value) => value.trim()).filter(Boolean).map((value) => Buffer.from(value, "base64")).filter((key) => key.length === 32);
  return { current: current?.length === 32 ? current : undefined, all: [...(current?.length === 32 ? [current] : []), ...previous] };
}
export function sealPayload(payload: object): object {
  const { current } = keys();
  if (!current) return payload;
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", current, nonce);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return { sealed: "v1", key: keyId(current), nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}
export function openPayload(stored: unknown): unknown {
  if (typeof stored !== "object" || stored === null || (stored as { sealed?: unknown }).sealed !== "v1") {
    // An unsealed row is accepted only where no key is configured; with a key, everything stored must be sealed.
    return keys().current ? undefined : stored;
  }
  const sealed = stored as { key: string; nonce: string; tag: string; data: string };
  const key = keys().all.find((candidate) => keyId(candidate) === sealed.key);
  if (!key) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.nonce, "base64"));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8"));
  } catch { return undefined; }
}

export async function storeHandle(kind: Kind, payload: object, expiresAt: number) {
  const sql = database();
  const handle = randomBytes(32).toString("base64url");
  const tenant = getEnv().TENANT_ID;
  // Bound accumulation from abandoned launches and expired sessions.
  await sql`delete from stetholink_private.browser_sessions where tenant_id = ${tenant} and expires_at <= now()`;
  await sql`insert into stetholink_private.browser_sessions (handle_hash, kind, tenant_id, payload, expires_at)
    values (${digest(handle)}, ${kind}, ${tenant}, ${JSON.stringify(sealPayload(payload))}::text::jsonb, ${new Date(expiresAt)})`;
  return handle;
}

export async function readHandle(handle: string | undefined, kind: Kind, consume = false): Promise<unknown> {
  if (!valid(handle)) return undefined;
  const sql = database();
  const tenant = getEnv().TENANT_ID;
  const where = sql`where handle_hash = ${digest(handle)} and kind = ${kind}
    and tenant_id = ${tenant} and expires_at > now()`;
  const [row] = consume
    ? await sql`delete from stetholink_private.browser_sessions ${where} returning payload`
    : await sql`select payload from stetholink_private.browser_sessions ${where}`;
  return row ? openPayload(row.payload) : undefined;
}
