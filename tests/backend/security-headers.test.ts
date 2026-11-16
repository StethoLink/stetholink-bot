import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, ehrFrameOrigins, frameOriginProblems, securityHeaders } from "@/platform/http/security-headers";

const ehr = { SMART_AUTHORIZATION_URL: "https://emr.hospital.example/oauth2/default/authorize", NODE_ENV: "production" };
const directive = (policy: string, name: string) => policy.split("; ").find((part) => part.startsWith(`${name} `))?.slice(name.length + 1);

describe("who may frame StethoLink", () => {
  it("is the origin of the EHR's sign-in page and nobody else", () => {
    expect(ehrFrameOrigins(ehr)).toEqual(["https://emr.hospital.example"]);
    expect(directive(contentSecurityPolicy(ehr, "n"), "frame-ancestors")).toBe("https://emr.hospital.example");
  });

  it("is the listed origins when the EHR's pages are served from another origin than its sign-in", () => {
    const env = { ...ehr, EHR_FRAME_ORIGINS: "https://chart.hospital.example, https://emr.hospital.example:9300" };
    expect(directive(contentSecurityPolicy(env, "n"), "frame-ancestors")).toBe("https://chart.hospital.example https://emr.hospital.example:9300");
    expect(frameOriginProblems(env)).toEqual([]);
  });

  it("is nobody when no EHR is configured", () => {
    expect(directive(contentSecurityPolicy({}, "n"), "frame-ancestors")).toBe("'none'");
  });

  it.each(["*", "https://*.hospital.example", "http://emr.hospital.example", "https://emr.hospital.example/path", "https://user:pw@emr.hospital.example", "emr.hospital.example", "'self' https://evil.example;"])(
    "never widens the policy for %s", (value) => {
      const env = { ...ehr, EHR_FRAME_ORIGINS: value };
      expect(frameOriginProblems(env)).toHaveLength(1);
      const ancestors = directive(contentSecurityPolicy(env, "n"), "frame-ancestors") ?? "";
      expect(ancestors).not.toMatch(/\*|http:|'self'|evil|;|\/path|user/);
    });

  it("does not send X-Frame-Options, which cannot name the EHR's origin", () => {
    expect(Object.keys(securityHeaders(ehr, "n")).map((name) => name.toLowerCase())).not.toContain("x-frame-options");
  });
});

describe("what the page may load and call", () => {
  const policy = contentSecurityPolicy(ehr, "bm9uY2U=");

  it.each(["default-src", "font-src", "connect-src"])("%s is this origin only", (name) => {
    expect(directive(policy, name)).toBe("'self'");
  });

  it("allows no host other than this origin and the EHR as the frame's parent", () => {
    const hosts = policy.split("; ").filter((part) => !part.startsWith("frame-ancestors ")).join(" ").match(/\bhttps?:[^\s;]*|\*/g);
    expect(hosts).toBeNull();
  });

  it("runs only scripts carrying this response's nonce", () => {
    expect(directive(policy, "script-src")).toBe("'self' 'nonce-bm9uY2U=' 'strict-dynamic'");
    expect(policy).not.toContain("unsafe-eval");
  });

  it("allows no plugin, no nested frame, no base change and no form posted elsewhere", () => {
    expect(directive(policy, "object-src")).toBe("'none'");
    expect(directive(policy, "frame-src")).toBe("'none'");
    expect(directive(policy, "base-uri")).toBe("'none'");
    expect(directive(policy, "form-action")).toBe("'self'");
  });

  it("sends no referrer and offers the microphone to this origin only", () => {
    const headers = securityHeaders(ehr, "n");
    expect(headers["Referrer-Policy"]).toBe("no-referrer");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Permissions-Policy"]).toContain("microphone=(self)");
  });
});
