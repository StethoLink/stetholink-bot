import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { database } from "@/platform/persistence/database";
import { getEnv } from "@/platform/tenants/env";

export const sessionCookie = "stetholink-session";
export const launchCookie = "stetholink-smart-launch";
type Kind = "session" | "launch";

const digest = (handle: string) => createHash("sha256").update(handle).digest("hex");
const valid = (handle: string | undefined): handle is string => !!handle && /^[\w-]{43}$/.test(handle);

export async function storeHandle(kind: Kind, payload: object, expiresAt: number) {
  const sql = database();
  const handle = randomBytes(32).toString("base64url");
  const tenant = getEnv().TENANT_ID;
  // Bound accumulation from abandoned launches and expired sessions.
  await sql`delete from stetholink_private.browser_sessions where tenant_id = ${tenant} and expires_at <= now()`;
  await sql`insert into stetholink_private.browser_sessions (handle_hash, kind, tenant_id, payload, expires_at)
    values (${digest(handle)}, ${kind}, ${tenant}, ${JSON.stringify(payload)}::text::jsonb, ${new Date(expiresAt)})`;
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
  return row?.payload;
}
