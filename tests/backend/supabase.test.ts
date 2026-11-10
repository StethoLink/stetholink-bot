import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupabaseTransport, SupabaseError } from "@/platform/auth/supabase";
import { verifyClinician, requireClinician, requireSameOrigin } from "@/platform/auth/session";
import { createConsultationRepository } from "@/platform/persistence";
import { createConsultationService } from "@/core/consultation/service";
import { syntheticClinicalAdapter } from "@/integrations/mock/connector";
import { mockProvider } from "@/core/agent/providers/mock-provider";
import { passthroughSafetyGuard } from "@/core/agent/safety/guard";

const { jar, requestHeaders, env } = vi.hoisted(() => ({
  jar: { get: vi.fn(), set: vi.fn(), delete: vi.fn() }, requestHeaders: new Headers(),
  env: { AUTH_MODE: "supabase", NODE_ENV: "production", NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test" },
}));
vi.mock("next/headers", () => ({ cookies: async () => jar, headers: async () => requestHeaders }));
vi.mock("@/platform/tenants/env", () => ({ getEnv: () => env }));

const uid = "11111111-1111-4111-8111-111111111111";
const row = { id: "draft-1", patient_id: "syn-pt-001", encounter_id: null, status: "pending_approval", summary: "Synthetic summary", assessment: "Synthetic assessment", plan: [], generated_by: "ai", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), reviewed_by: null, reviewed_at: null };
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); for (const key of [...requestHeaders.keys()]) requestHeaders.delete(key); });

describe("Supabase authorization", () => {
  it("accepts only server-verified clinician app metadata", async () => {
    const request = vi.fn().mockResolvedValue({ id: uid, app_metadata: { role: "clinician" } });
    expect(await verifyClinician("user-token", request)).toEqual({ clinicianId: uid, roles: ["clinician"], accessToken: "user-token" });
    expect(request).toHaveBeenCalledWith("/auth/v1/user", {}, "user-token");
    request.mockResolvedValue({ id: uid, app_metadata: {}, user_metadata: { role: "admin" } });
    await expect(verifyClinician("token", request)).rejects.toMatchObject({ code: "forbidden" });
    request.mockResolvedValue({ id: uid, app_metadata: { role: "clinician" }, is_anonymous: true });
    await expect(verifyClinician("token", request)).rejects.toMatchObject({ code: "forbidden" });
  });
  it("rejects unauthenticated requests and cross-origin cookie requests", async () => {
    jar.get.mockReturnValue(undefined);
    await expect(requireClinician()).rejects.toMatchObject({ code: "unauthenticated" });
    requestHeaders.set("host", "stetholink.example"); requestHeaders.set("origin", "https://evil.example");
    await expect(requireSameOrigin()).rejects.toMatchObject({ code: "forbidden" });
  });
  it("refreshes an expired cookie and stores only httpOnly session cookies", async () => {
    jar.get.mockImplementation((name) => name === "stetholink-access" ? { value: "expired" } : { value: "refresh" });
    const user = { id: uid, app_metadata: { role: "clinician" } };
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ code: "bad_jwt" }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600, user }))
      .mockResolvedValueOnce(Response.json(user));
    vi.stubGlobal("fetch", fetcher);
    expect((await requireClinician()).accessToken).toBe("new-access");
    expect(jar.set).toHaveBeenCalledWith("stetholink-access", "new-access", expect.objectContaining({ httpOnly: true, secure: true, sameSite: "lax" }));
  });
  it("does not refresh invalid bearer tokens with a browser cookie", async () => {
    requestHeaders.set("authorization", "Bearer invalid");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({}, { status: 401 })));
    await expect(requireClinician()).rejects.toMatchObject({ code: "unauthenticated" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("user-scoped persistence", () => {
  it("sends the caller token and disables caching", async () => {
    const doFetch = vi.fn().mockResolvedValue(Response.json([row]));
    const transport = createSupabaseTransport({ url: "https://example.supabase.co", key: "public" }, doFetch);
    const repo = createConsultationRepository("caller-token", transport);
    expect((await repo.get("draft-1"))?.patientId).toBe("syn-pt-001");
    expect(doFetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ cache: "no-store", headers: expect.objectContaining({ Authorization: "Bearer caller-token", apikey: "public" }) }));
  });
  it("does not leak database response bodies through errors", async () => {
    const transport = createSupabaseTransport({ url: "https://example.supabase.co", key: "public" }, vi.fn().mockResolvedValue(Response.json({ code: "42501", message: "sensitive data" }, { status: 403 })));
    await expect(transport("/rest/v1/consultation_drafts")).rejects.toEqual(new SupabaseError(403, "42501"));
  });
  it("uses an atomic RPC for approvals and never sends a client clinician id", async () => {
    const request = vi.fn().mockResolvedValue([{ ...row, status: "approved", reviewed_by: uid, reviewed_at: row.created_at }]);
    const result = await createConsultationRepository("token", request).approve({ draftId: "draft-1", decision: "approve" });
    expect(result.reviewedBy).toBe(uid);
    expect(request.mock.calls[0][0]).toBe("/rest/v1/rpc/record_consultation_approval");
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ p_draft_id: "draft-1", p_decision: "approve", p_comment: null });
  });
});

describe("consultation generation", () => {
  function setup() {
    const repository = { get: vi.fn(), approve: vi.fn(), create: vi.fn(async (draft) => draft) };
    const deps = { repository, provider: mockProvider, safety: passthroughSafetyGuard, adapter: syntheticClinicalAdapter };
    return { deps, repository };
  }
  it("saves a pending draft with provenance and the session owner", async () => {
    const { deps, repository } = setup();
    const result = await createConsultationService(deps).create({ patientId: "syn-pt-001" }, uid);
    expect(result.status).toBe("pending_approval");
    expect(repository.create).toHaveBeenCalledWith(result, uid, { provider: "mock", model: "mock-1", promptVersion: "system@0.1.0" });
  });
  it("never saves blocked model output", async () => {
    const { deps, repository } = setup();
    deps.safety = { assess: async () => ({ level: "blocked", reasons: [] }) };
    await expect(createConsultationService(deps).create({ patientId: "syn-pt-001" }, uid)).rejects.toMatchObject({ code: "safety_blocked" });
    expect(repository.create).not.toHaveBeenCalled();
  });
  it("rejects missing patients and unsupported conversation references", async () => {
    const { deps, repository } = setup();
    await expect(createConsultationService(deps).create({ patientId: "missing" }, uid)).rejects.toMatchObject({ code: "not_found" });
    await expect(createConsultationService(deps).create({ patientId: "syn-pt-001", conversationId: "missing" }, uid)).rejects.toMatchObject({ code: "invalid_request" });
    expect(repository.create).not.toHaveBeenCalled();
  });
});
