import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as createDraft } from "@/apps/embedded-app/app/api/consultations/drafts/route";
import { GET as getDraft } from "@/apps/embedded-app/app/api/consultations/drafts/[draftId]/route";
import { POST as approveDraft } from "@/apps/embedded-app/app/api/consultations/drafts/[draftId]/approval/route";

const { session, consultations } = vi.hoisted(() => ({
  session: vi.fn(), consultations: { create: vi.fn(), get: vi.fn(), approve: vi.fn() },
}));
vi.mock("@/apps/embedded-app/server", async () => {
  const respond = await import("@/apps/embedded-app/server/http/respond");
  return { ...respond, requireClinician: session, getConsultations: () => consultations };
});
const uid = "11111111-1111-4111-8111-111111111111";
const draft = { id: "draft-1", patientId: "syn-pt-001", status: "pending_approval", summary: "Synthetic", assessment: "Synthetic", plan: [], generatedBy: "ai", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
afterEach(() => vi.resetAllMocks());
const post = (body: unknown) => new Request("http://localhost/api/consultations/drafts", { method: "POST", body: JSON.stringify(body) });
describe("consultation routes", () => {
  it("requires authentication before reading input or calling services", async () => {
    const { AuthError } = await import("@/platform/auth/session");
    session.mockRejectedValue(new AuthError("unauthenticated", "Sign in required"));
    expect((await createDraft(post({ patientId: "syn-pt-001" }))).status).toBe(401);
    expect(consultations.create).not.toHaveBeenCalled();
  });
  it("uses session identity and returns a validated created draft", async () => {
    session.mockResolvedValue({ clinicianId: uid, roles: ["clinician"] });
    consultations.create.mockResolvedValue(draft);
    const res = await createDraft(post({ patientId: "syn-pt-001", clinicianId: "forged" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(draft);
    expect(consultations.create).toHaveBeenCalledWith({ patientId: "syn-pt-001" }, uid);
  });
  it("rejects invalid requests", async () => {
    session.mockResolvedValue({ clinicianId: uid });
    expect((await createDraft(post({ patientId: "" }))).status).toBe(400);
    expect(consultations.create).not.toHaveBeenCalled();
  });
  it("returns 404 for missing or inaccessible drafts", async () => {
    session.mockResolvedValue({ clinicianId: uid }); consultations.get.mockResolvedValue(null);
    expect((await getDraft(new Request("http://localhost"), { params: Promise.resolve({ draftId: "missing" }) })).status).toBe(404);
  });
  it("rejects mismatched approval body and URL", async () => {
    session.mockResolvedValue({ clinicianId: uid });
    const res = await approveDraft(post({ draftId: "other", decision: "approve" }), { params: Promise.resolve({ draftId: "draft-1" }) });
    expect(res.status).toBe(400); expect(consultations.approve).not.toHaveBeenCalled();
  });
  it("returns a conflict for an already reviewed draft", async () => {
    const { SupabaseError } = await import("@/platform/auth/supabase");
    session.mockResolvedValue({ clinicianId: uid }); consultations.approve.mockRejectedValue(new SupabaseError(400, "P0001"));
    const res = await approveDraft(post({ draftId: "draft-1", decision: "approve" }), { params: Promise.resolve({ draftId: "draft-1" }) });
    expect(res.status).toBe(409);
  });
});
