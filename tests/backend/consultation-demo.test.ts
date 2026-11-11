import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/apps/embedded-app/app/api/consultations/demo/route";
import { previewConsultationDemo } from "@/apps/embedded-app/server/consultation-demo";
import { consultationDraftSchema } from "@/shared/schemas";
import { mockProvider } from "@/core/agent/providers/mock-provider";
import { AuthError } from "@/platform/auth/session";
import type { VerifiedLaunch } from "@/platform/auth/identity";

const { session, localSyntheticEnabled, env, tenant } = vi.hoisted(() => ({
  session: vi.fn(), localSyntheticEnabled: vi.fn(() => false), env: { NODE_ENV: "production" }, tenant: { connector: "synthetic" },
}));
vi.mock("@/platform/auth/session", async (original) => ({ ...await original<typeof import("@/platform/auth/session")>(), localSyntheticEnabled }));
vi.mock("@/platform/tenants/env", () => ({ getEnv: () => env }));
vi.mock("@/platform/tenants", () => ({ getTenant: () => tenant }));
vi.mock("@/platform/tenants/model-provider", () => ({ getModelProvider: () => mockProvider }));
vi.mock("@/apps/embedded-app/server", async () => ({
  ...await import("@/apps/embedded-app/server/http/respond"), requireClinician: session,
}));
const verified: VerifiedLaunch = {
  source: "synthetic",
  context: {
    clinicianId: "verified-synthetic-clinician", tenantId: "synthetic", roles: ["physician"],
    scopes: ["consultation:draft"], patientId: "syn-pt-001", encounterId: "syn-enc-001",
    expiresAt: Date.now() + 600_000, authorization: "active",
  },
};
const request = () => new Request("https://staging.example/api/consultations/demo", { method: "POST" });
beforeEach(() => { vi.stubEnv("VERCEL_ENV", "preview"); env.NODE_ENV = "production"; tenant.connector = "synthetic"; session.mockResolvedValue(verified); localSyntheticEnabled.mockReturnValue(false); });
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

describe("protected staging consultation demo", () => {
  it("requires authentication before any demo work", async () => {
    session.mockRejectedValue(new AuthError("unauthenticated", "Sign in required"));
    expect((await POST(request())).status).toBe(401);
  });
  it("returns a contract-valid pending Ahmed draft from the verified session", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    const draft = consultationDraftSchema.parse(await response.json());
    expect(draft.patientId).toBe("syn-pt-ahmed");
    expect(draft.grounding?.specialty).toBe("Cardiology");
    expect(draft.status).toBe("pending_approval");
    expect(draft.reviewedBy).toBeUndefined();
    expect(draft.missingInformation?.find((fact) => fact.id === "ahmed-troponin")?.status).toBe("unknown");
  });
  it("rejects all caller-supplied content and identity", async () => {
    const response = await POST(new Request(request(), { body: JSON.stringify({ patientId: "other", clinicianId: "forged", clinicalQuestion: "Never send this text to a model" }) }));
    expect(response.status).toBe(400);
  });
  it.each(["production", "", "development"])("denies production runtime outside Vercel preview (%s)", async (value) => {
    vi.stubEnv("VERCEL_ENV", value);
    expect((await POST(request())).status).toBe(403);
  });
  it("denies a development auth bypass even on a preview deployment", async () => {
    localSyntheticEnabled.mockReturnValue(true);
    expect((await POST(request())).status).toBe(401);
  });
  it("denies nonclinician, expired and nonsynthetic sessions", async () => {
    await expect(previewConsultationDemo({ ...verified, context: { ...verified.context, roles: [] } })).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(previewConsultationDemo({ ...verified, context: { ...verified.context, expiresAt: 0 } })).rejects.toMatchObject({ code: "unauthenticated" });
    tenant.connector = "fhir";
    expect((await POST(request())).status).toBe(403);
  });
});
