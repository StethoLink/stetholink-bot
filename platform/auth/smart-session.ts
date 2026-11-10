import "server-only";
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { beginSmartLaunch, exchangeSmartCode, type SmartRegistration } from "@/integrations/fhir/smart";
import type { FhirLaunchGrant } from "@/integrations/fhir/connector";
import { getEnv } from "@/platform/tenants/env";
import { RouteError } from "@/core/errors";
import type { ClinicianSession } from "./session";

const launchCookie = "stetholink-smart-launch";
const grantCookie = "stetholink-smart-grant";
const cookie = { secure: true, httpOnly: true, sameSite: "lax" as const, path: "/" };

type Pending = ReturnType<typeof beginSmartLaunch>["pending"];
type Entry<T> = { clinicianId: string; tenantId: string; expiresAt: number; value: T };
const globals = globalThis as typeof globalThis & {
  stetholinkSmartSandbox?: { pending: Map<string, Entry<Pending>>; grants: Map<string, Entry<FhirLaunchGrant>> };
};
const store = globals.stetholinkSmartSandbox ??= { pending: new Map<string, Entry<Pending>>(), grants: new Map<string, Entry<FhirLaunchGrant>>() };

function add<T>(entries: Map<string, Entry<T>>, clinicianId: string, value: T, expiresAt: number) {
  for (const [id, entry] of entries) if (entry.expiresAt <= Date.now()) entries.delete(id);
  if (entries.size >= 256) throw new RouteError("provider_unavailable", "SMART sandbox session limit reached");
  const id = randomBytes(32).toString("base64url");
  entries.set(id, { clinicianId, tenantId: getEnv().TENANT_ID, value, expiresAt });
  return id;
}

function authorize<T>(entry: Entry<T> | undefined, session: ClinicianSession) {
  return session.accessToken && entry && entry.expiresAt > Date.now() &&
    entry.clinicianId === session.clinicianId && entry.tenantId === getEnv().TENANT_ID ? entry : undefined;
}

function registration(): SmartRegistration {
  const env = getEnv();
  if (env.NODE_ENV === "production" || env.AUTH_MODE !== "supabase" || env.CLINICAL_DATA_SOURCE === "synthetic" ||
      !env.FHIR_BASE_URL || !env.SMART_CLIENT_ID || !env.SMART_AUTHORIZATION_URL || !env.SMART_TOKEN_URL ||
      !env.SMART_REDIRECT_URI || !env.SMART_SCOPE) {
    throw new RouteError("not_implemented", "SMART read-only sandbox is not configured");
  }
  return {
    issuer: env.FHIR_BASE_URL, authorizationEndpoint: env.SMART_AUTHORIZATION_URL,
    tokenEndpoint: env.SMART_TOKEN_URL, clientId: env.SMART_CLIENT_ID,
    redirectUri: env.SMART_REDIRECT_URI, scope: env.SMART_SCOPE,
  };
}

export async function openSmartLaunch(session: ClinicianSession, issuer: string, launch: string) {
  if (!session.accessToken) throw new RouteError("forbidden", "A verified clinician session is required");
  const { authorizationUrl, pending } = beginSmartLaunch(registration(), issuer, launch);
  const jar = await cookies();
  const previous = jar.get(launchCookie)?.value;
  if (previous) store.pending.delete(previous);
  const priorGrant = jar.get(grantCookie)?.value;
  if (priorGrant) store.grants.delete(priorGrant);
  jar.delete(grantCookie);
  const id = add(store.pending, session.clinicianId, pending, pending.expiresAt);
  jar.set(launchCookie, id, { ...cookie, maxAge: 300 });
  return authorizationUrl;
}

export async function finishSmartLaunch(session: ClinicianSession, callback: { state: string; code: string }) {
  const jar = await cookies();
  const id = jar.get(launchCookie)?.value;
  const entry = id ? authorize(store.pending.get(id), session) : undefined;
  if (!entry || !id || entry.value.state !== callback.state) throw new RouteError("forbidden", "SMART launch session is missing or expired");
  store.pending.delete(id);
  jar.delete(launchCookie);
  const result = await exchangeSmartCode(registration(), entry.value, callback);
  const expiresAt = Math.min(result.expiresAt, Date.now() + 15 * 60_000);
  const grantId = add(store.grants, session.clinicianId, result.grant, expiresAt);
  jar.set(grantCookie, grantId, { ...cookie, maxAge: Math.floor((expiresAt - Date.now()) / 1000) });
}

export async function getSmartGrant(session: ClinicianSession) {
  registration();
  const jar = await cookies();
  const id = jar.get(grantCookie)?.value;
  const entry = id ? authorize(store.grants.get(id), session) : undefined;
  if (!entry) throw new RouteError("forbidden", "Launch StethoLink from the authorized EHR patient chart");
  return entry.value;
}

export async function clearSmartSession() {
  const jar = await cookies();
  const pending = jar.get(launchCookie)?.value;
  const grant = jar.get(grantCookie)?.value;
  if (pending) {
    store.pending.delete(pending);
    jar.delete(launchCookie);
  }
  if (grant) {
    store.grants.delete(grant);
    jar.delete(grantCookie);
  }
}
