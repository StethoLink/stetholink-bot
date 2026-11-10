import { afterEach, describe, expect, it, vi } from "vitest";
import { login, logout, loginPage } from "@/apps/embedded-app/server/auth-routes";
const { jar, requestHeaders } = vi.hoisted(() => ({ jar: { get: vi.fn(), set: vi.fn(), delete: vi.fn() }, requestHeaders: new Headers({ host: "localhost" }) }));
vi.mock("next/headers", () => ({ cookies: async () => jar, headers: async () => requestHeaders }));
vi.mock("@/platform/tenants/env", () => ({ getEnv: () => ({ NODE_ENV: "production", NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "public" }) }));
const user = { id: "11111111-1111-4111-8111-111111111111", app_metadata: { role: "clinician" } };
const tokens = { access_token: "access", refresh_token: "refresh", expires_in: 3600, user };
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); requestHeaders.delete("origin"); });
const req = (data: unknown) => new Request("http://localhost/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
describe("sign in and logout", () => {
  it("provides a usable password form without inline scripts", async () => {
    const response = loginPage();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain('action="/api/auth/login"');
  });
  it("does not return tokens or passwords to the browser JSON response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(tokens)));
    const response = await login(req({ email: "synthetic@example.test", password: "test-password" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ clinicianId: user.id, roles: ["clinician"] });
    expect(jar.set).toHaveBeenCalledWith("stetholink-refresh", "refresh", expect.objectContaining({ httpOnly: true, secure: true }));
  });
  it("rejects invalid credentials without exposing provider errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ code: "invalid_credentials", message: "private diagnostic" }, { status: 400 })));
    const response = await login(req({ email: "synthetic@example.test", password: "wrong" }));
    expect(response.status).toBe(401); expect(await response.text()).not.toContain("private diagnostic");
    expect(jar.set).not.toHaveBeenCalled();
  });
  it("revokes a login without a clinician role and sets no cookies", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ ...tokens, user: { ...user, app_metadata: {} } })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    expect((await login(req({ email: "synthetic@example.test", password: "test" }))).status).toBe(403);
    expect(fetcher).toHaveBeenCalledTimes(2); expect(jar.set).not.toHaveBeenCalled();
  });
  it("rejects cross-origin login before sending credentials", async () => {
    requestHeaders.set("origin", "https://evil.example");
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect((await login(req({ email: "synthetic@example.test", password: "test" }))).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("revokes the refreshed session on logout even after access expiry", async () => {
    jar.get.mockImplementation((name) => name === "stetholink-refresh" ? { value: "old-refresh" } : undefined);
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(tokens)).mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    expect((await logout()).status).toBe(204);
    expect(fetcher.mock.calls[1][1].headers.Authorization).toBe("Bearer access");
    expect(jar.delete).toHaveBeenCalledWith("stetholink-access"); expect(jar.delete).toHaveBeenCalledWith("stetholink-refresh");
  });
});
