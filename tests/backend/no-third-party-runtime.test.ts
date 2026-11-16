import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Nothing the clinician's browser runs may come from, or report to, anyone but this server:
 * no font service, analytics, error tracker, tag manager or CDN, and no new window. A hospital
 * network is often closed, and a request to a third party from inside the chart is a disclosure.
 * The response policy (tests/backend/security-headers.test.ts) blocks such a request in the browser;
 * this test fails the build when the code that would make one comes back.
 */
const root = join(import.meta.dirname, "../..");
const productDirs = ["apps", "shared", "core", "platform", "integrations"];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === ".next") return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}
const sources = productDirs.flatMap((dir) => files(join(root, dir))).filter((path) => /\.(tsx?|mjs|css|html)$/.test(path));
const text = (path: string) => readFileSync(path, "utf8");
const offenders = (pattern: RegExp, among = sources) => among.filter((path) => pattern.test(text(path))).map((path) => relative(root, path));

describe("no third party at run time", () => {
  it("has no analytics, tracking, error-reporting or hosted-font package", () => {
    const manifest = JSON.parse(text(join(root, "package.json"))) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const banned = /analytics|speed-insights|sentry|posthog|mixpanel|segment|amplitude|hotjar|fullstory|logrocket|datadog|newrelic|bugsnag|rollbar|gtag|google-tag|googletagmanager|plausible|matomo|clarity|intercom|typekit|webfontloader/i;
    expect(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter((name) => banned.test(name))).toEqual([]);
  });

  it("loads fonts from this application only", () => {
    expect(offenders(/next\/font\/google|fonts\.googleapis|fonts\.gstatic|use\.typekit|@import\s+url\(|url\(\s*["']?(?:https?:)?\/\//)).toEqual([]);
    expect(text(join(root, "apps/embedded-app/app/fonts/index.ts"))).toContain("next/font/local");
  });

  it("names no outside address in anything the browser receives", () => {
    // Server code reaches the EHR and the model through addresses in the configuration, never through a literal.
    const browser = sources.filter((path) => /apps\/embedded-app\/(app\/(?!api\/)|components\/|features\/|i18n\/)|shared\//.test(path));
    expect(browser.length).toBeGreaterThan(50);
    // The only literal allowed is the XML namespace of an inline SVG, which is a name and is never fetched.
    const outside = /(?:https?:)?\/\/(?!www\.w3\.org\/(?:2000\/svg|1999\/xlink))[a-z0-9-]+(?:\.[a-z0-9-]+)+/i;
    const hits = browser.flatMap((path) => text(path).split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && outside.test(line))
      .map((line) => `${relative(root, path)}: ${line.trim().slice(0, 80)}`));
    expect(hits).toEqual([]);
  });

  it("adds no script, beacon, image or frame from elsewhere", () => {
    expect(offenders(/next\/script|<script[^>]+src=|sendBeacon|dangerouslySetInnerHTML|<iframe|<object|<embed|new Image\(/)).toEqual([]);
  });

  it("opens no popup and no new window or tab", () => {
    expect(offenders(/window\.open\s*\(|target=["']_blank|target:\s*["']_blank|(?:top|parent)\.location|location\.(?:assign|replace)\(|location\.href\s*=/)).toEqual([]);
  });

  it("keeps the framework's own telemetry off in the production image", () => {
    const stages = text(join(root, "Dockerfile")).split(/^FROM /m).slice(1);
    expect(stages.length).toBeGreaterThan(0);
    for (const stage of stages) expect(stage).toContain("NEXT_TELEMETRY_DISABLED=1");
  });

  it("sends the policy from the middleware on every path", () => {
    const middleware = text(join(root, "apps/embedded-app/middleware.ts"));
    expect(middleware).toContain("securityHeaders(");
    expect(middleware).toMatch(/matcher:\s*"\/:path\*"/);
  });
});
