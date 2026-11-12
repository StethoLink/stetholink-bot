// Browser walk-through of the clinician workflow against a running synthetic staging app:
// synthetic chart -> assistant draft -> source review -> natural-language revision -> physician
// approval for a provider -> send -> delivery states -> specialist response -> history after reload.
//
//   STAGING_BASE_URL=http://127.0.0.1:3000 STAGING_LAUNCH_SECRET=... node tests/e2e/browser/consultation-flow.mjs
//
// Needs Playwright with Chromium available to Node (it is not a project dependency).
// EXPECT_LIVE_MODEL=1 additionally requires that the draft came from real model inference.
// The specialist is always the built-in simulated provider.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");
const base = process.env.STAGING_BASE_URL ?? "http://127.0.0.1:3000";
const secret = process.env.STAGING_LAUNCH_SECRET;
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname) || new URL(base).protocol === "https:", "Use HTTPS except on loopback");
assert.ok(secret && secret.length >= 32, "Set STAGING_LAUNCH_SECRET");
const expectLive = process.env.EXPECT_LIVE_MODEL === "1";
const shots = process.env.BROWSER_SCREENSHOT_DIR;
const REQUEST = "Prepare a cardiology consultation for this patient regarding possible acute coronary syndrome.";
const REVISION = "Make the consultation shorter and focus on the ECG findings.";
const modelTimeout = expectLive ? 120_000 : 30_000;

const browser = await chromium.launch();
let step = 0;
async function shot(page, name) {
  if (!shots) return;
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/${String(++step).padStart(2, "0")}-${name}.png`, fullPage: true });
}
async function launch(profile) {
  const context = await browser.newContext({ viewport: { width: 900, height: 1100 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${base}/staging#secret=${secret}`);
  await page.getByLabel("Synthetic chart and role").selectOption(profile);
  await page.getByRole("button", { name: "Open synthetic chart" }).click();
  await page.waitForURL("**/embed");
  return { context, page, errors };
}
const tracker = (page) => page.getByLabel("Consultation progress");
const current = (page) => tracker(page).locator('[aria-current="step"]');

try {
  // --- 1. Patient context -------------------------------------------------------------
  const { page, errors } = await launch("chest-pain-demo");
  await page.getByRole("heading", { name: "Omar (fictional chest-pain case)" }).waitFor();
  await page.getByText("Synthetic data").first().waitFor();
  const record = page.locator("details", { hasText: "Chart record" });
  await record.getByText("ST depression of 1 mm in leads V4 to V6").waitFor();
  assert.match(await record.innerText(), /Echocardiogram:\s*not performed/);
  await page.getByText("Emergency encounter").waitFor();
  await shot(page, "chart");

  // --- 2-3. Natural-language request and draft ----------------------------------------
  const assistant = page.getByRole("region", { name: "Consultation assistant" });
  await assistant.getByText("None yet.").waitFor();
  await assistant.getByLabel("What consultation do you need?").fill(REQUEST);
  await assistant.getByRole("button", { name: "Prepare consultation" }).click();
  await assistant.getByText("Reading the chart and drafting").waitFor();
  const review = page.getByRole("region", { name: "Consultation review" });
  await review.getByRole("heading", { name: "Cardiology consultation request" }).waitFor({ timeout: modelTimeout });
  const draftText = await review.innerText();
  assert.ok(draftText.includes(REQUEST), "The physician's request is shown verbatim");
  for (const part of ["Clinical question", "Relevant history", "Presenting symptoms", "Examination findings", "Available investigations", "Current medications", "Missing information", "AI suggestions", "Source evidence"]) {
    assert.ok(draftText.toLowerCase().includes(part.toLowerCase()), `Draft shows ${part}`);
  }
  const live = !draftText.includes("Demo fallback");
  if (expectLive) assert.ok(live && /Drafted by \w+ model/.test(draftText), "Expected a draft from live model inference");
  else assert.ok(draftText.includes("Demo fallback, not AI"), "The deterministic fallback must be labelled as not AI");
  assert.equal((await current(page).innerText()).trim().startsWith("●"), true);
  assert.match(await current(page).innerText(), /Prepared/);
  // Missing information comes from the chart.
  const missing = review.getByRole("region", { name: "Missing information" });
  for (const item of ["Echocardiogram: not performed", "Repeat high-sensitivity troponin I: result pending"]) assert.ok((await missing.innerText()).includes(item));
  await shot(page, "draft");

  // --- 4a. Source evidence ------------------------------------------------------------
  const findings = review.getByRole("region", { name: "Documented findings" });
  const ecgSource = findings.getByRole("link", { name: "Source: 12-lead ECG" }).first();
  await ecgSource.waitFor();
  assert.equal(await findings.getByText("No chart source").count(), 0, "Every statement cites the chart");
  await ecgSource.click();
  const evidence = review.locator("details", { hasText: "Source evidence" });
  const target = evidence.locator("li:target");
  assert.match(await target.innerText(), /12-lead ECG:.*ST depression of 1 mm in leads V4 to V6/s);
  assert.match(await target.innerText(), /synthetic-case-omar-v1/);
  await shot(page, "source-evidence");

  // --- 4b. Natural-language revision ---------------------------------------------------
  const before = await findings.innerText();
  const revise = review.getByRole("form", { name: "Ask the assistant to revise" });
  await revise.getByLabel("Ask the assistant to revise this draft").fill(REVISION);
  await revise.getByRole("button", { name: "Revise draft" }).click();
  await review.getByText("last changed").waitFor({ timeout: modelTimeout });
  await review.getByRole("form", { name: "Ask the assistant to revise" }).getByRole("button", { name: "Revise draft" }).waitFor();
  const after = await review.getByRole("region", { name: "Documented findings" }).innerText();
  assert.match(await current(page).innerText(), /Prepared/, "A revised draft is back in physician review, not approved");
  assert.ok(after.includes("ST depression"), "The ECG finding survives the revision");
  assert.equal(await review.getByRole("region", { name: "Documented findings" }).getByText("No chart source").count(), 0);
  if (live) assert.ok(after.length < before.length, "The live model shortened the draft");
  await shot(page, "revised");

  // --- 4c-5. Approval for a chosen provider --------------------------------------------
  assert.equal(await review.getByRole("button", { name: "Send approved consultation" }).count(), 0, "Nothing can be sent before approval");
  await review.getByRole("button", { name: "Approve", exact: true }).click();
  const confirm = review.getByRole("button", { name: "Confirm approve" });
  assert.equal(await confirm.isDisabled(), true, "Approval needs a destination");
  const destination = review.getByLabel("Destination");
  const options = await destination.locator("option").allInnerTexts();
  assert.ok(options.some((text) => text === "Synthetic Cardiology Consult Service (simulated)"));
  assert.ok(options.every((text) => !/Radiology|suspended/i.test(text)), "Only eligible cardiology providers are offered");
  await destination.selectOption({ label: "Synthetic Cardiology Consult Service (simulated)" });
  await review.getByText("Simulated provider. No real specialist").waitFor();
  await shot(page, "approve");
  await confirm.click();

  // --- 6-7. Send and status tracking ----------------------------------------------------
  const routing = review.getByRole("region", { name: "Routing and specialist response" });
  await routing.getByText("Approved. Not sent yet.").waitFor();
  assert.match(await current(page).innerText(), /Approved/);
  await routing.getByText("Simulated provider", { exact: true }).waitFor();
  assert.equal(await review.getByRole("form", { name: "Ask the assistant to revise" }).count(), 0, "An approved consultation cannot be revised");
  await routing.getByRole("button", { name: "Send approved consultation" }).click();
  await routing.getByText("Delivered to the provider. Waiting for it to accept.").waitFor();
  await page.waitForFunction(() => document.querySelector('[aria-label="Consultation progress"] [aria-current="step"]')?.textContent?.includes("Delivered"));
  await shot(page, "delivered");
  await routing.getByRole("button", { name: /Simulate the provider/ }).click();
  await routing.getByText("Accepted by the provider.").waitFor();
  await page.waitForFunction(() => document.querySelector('[aria-label="Consultation progress"] [aria-current="step"]')?.textContent?.includes("Accepted"));
  await routing.getByRole("button", { name: /Simulate the provider/ }).click();

  // --- 8. Specialist response ------------------------------------------------------------
  const response = routing.getByRole("article", { name: "Specialist response" });
  await response.waitFor();
  const responseText = await response.innerText();
  assert.match(responseText, /Simulated response\. Generated by the built-in test provider, not written by a clinician\./);
  assert.match(responseText, /Synthetic Cardiology Consult Service/);
  assert.match(responseText, /request [0-9a-f]{8}/);
  await routing.getByText("The specialist has responded.").waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Consultation progress"] [aria-current="step"]'));
  assert.equal(await tracker(page).locator("li", { hasText: "Responded" }).getByText("completed").count(), 1);
  assert.equal(await routing.getByRole("button", { name: "Send approved consultation" }).count(), 0);
  await shot(page, "response");

  // --- 9. History after a full reload -----------------------------------------------------
  await page.reload();
  const history = page.getByRole("region", { name: "Consultation assistant" });
  const entry = history.getByRole("button", { name: /Cardiology.*Specialist responded/s });
  await entry.waitFor();
  await shot(page, "history");
  await entry.click();
  await page.getByRole("article", { name: "Specialist response" }).waitFor();
  assert.ok((await page.getByRole("region", { name: "Consultation review" }).innerText()).includes(REQUEST));
  await shot(page, "reopened");

  // --- A non-physician on another chart sees no decision or send controls -----------------
  const observer = await launch("observer");
  await observer.page.getByText("This session can prepare drafts only.").waitFor();
  const observed = observer.page.getByRole("region", { name: "Consultation assistant" });
  await observed.getByLabel("What consultation do you need?").fill("Prepare a cardiology consultation about blood pressure control.");
  await observed.getByRole("button", { name: "Prepare consultation" }).click();
  const observedReview = observer.page.getByRole("region", { name: "Consultation review" });
  await observedReview.getByText("A physician must review this draft before it can be sent.").waitFor({ timeout: modelTimeout });
  for (const name of ["Approve", "Reject", "Revise draft", "Send approved consultation"]) {
    assert.equal(await observedReview.getByRole("button", { name, exact: true }).count(), 0, `Observer has no ${name} control`);
  }
  assert.deepEqual([...errors, ...observer.errors], [], "No uncaught browser errors");
  console.log(`Passed browser workflow (${live ? "live model inference" : "deterministic fallback, no AI inference"}; simulated specialist): chart, request, sourced draft, revision, approval for a provider, send, delivery states, labelled simulated response, and history after reload.`);
} finally {
  await browser.close();
}
