// Browser walk-through of the scribe against a running synthetic staging app with SCRIBE_ENABLED=true:
// consent gate -> recording (Chromium fake microphone) -> parts uploaded -> note with sources ->
// physician selects a new allergy -> approval dialog -> result ("copy to chart" in synthetic mode).
// The transcription and note stand-ins are deterministic and labelled as such in the interface.
//
//   STAGING_BASE_URL=http://127.0.0.1:3000 STAGING_LAUNCH_SECRET=... SCRIBE_FAKE_AUDIO=/path/to/any.wav node tests/e2e/browser/scribe-flow.mjs
//
// Needs Playwright with Chromium (not a project dependency). SCRIBE_FAKE_AUDIO should hold sound followed by a
// pause: a part is cut at a pause after 20 seconds of sound, or at 30 seconds.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");
const base = process.env.STAGING_BASE_URL ?? "http://127.0.0.1:3000";
const secret = process.env.STAGING_LAUNCH_SECRET;
assert.ok(secret && secret.length >= 32, "Set STAGING_LAUNCH_SECRET");
const shots = process.env.BROWSER_SCREENSHOT_DIR;
const audio = process.env.SCRIBE_FAKE_AUDIO;
const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", ...(audio ? [`--use-file-for-fake-audio-capture=${audio}`] : [])] });
let step = 0;
async function shot(page, name) {
  if (!shots) return;
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/${String(++step).padStart(2, "0")}-${name}.png`, fullPage: true });
}
try {
  const context = await browser.newContext({ viewport: { width: Number(process.env.BROWSER_WIDTH ?? 420), height: 900 }, permissions: ["microphone"] });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${base}/staging#secret=${secret}`);
  await page.getByLabel("Synthetic chart and role").selectOption("physician");
  await page.getByRole("button", { name: "Open synthetic chart" }).click();
  await page.waitForURL("**/embed");
  await page.getByRole("tab", { name: "Scribe" }).click();
  const scribe = page.getByRole("region", { name: "Visit scribe" });
  await scribe.getByText("Demo stand-in.").waitFor();
  await shot(page, "scribe-start");

  // Consent gate: recording cannot start until the clinician confirms the patient's agreement.
  await scribe.getByRole("button", { name: "Start recording" }).click();
  const start = page.getByRole("dialog").getByRole("button", { name: "Start recording" });
  assert.equal(await start.isDisabled(), true, "Recording needs the consent confirmation");
  await shot(page, "consent");
  await page.getByLabel("The patient agreed verbally to this visit being recorded.").check();
  await start.click();
  await scribe.getByText("Recording", { exact: true }).waitFor();
  await shot(page, "recording");
  await scribe.getByRole("button", { name: "Pause" }).click();
  await scribe.getByText("Paused. Not recording").waitFor();
  await scribe.getByRole("button", { name: "Resume" }).click();
  // Let at least one part end at a pause in speech and upload while the visit continues.
  await scribe.getByText(/[1-9]\d* parts? transcribed/).waitFor({ timeout: 60_000 });
  await scribe.getByRole("button", { name: "End visit and write note" }).click();

  const review = page.getByRole("region", { name: "Visit note review" });
  await review.getByRole("heading", { name: "Visit note (SOAP)" }).waitFor({ timeout: 60_000 });
  await review.getByText("Awaiting physician review").waitFor();
  await review.getByText("Demo fallback (no AI inference)").waitFor();
  // One press on a statement's source shows the words of the visit behind it.
  await review.getByRole("button", { name: /^Source: visit/ }).first().click();
  await review.getByText(/^Quoted:/).first().waitFor();
  await shot(page, "note");

  // Proposed items start unselected; the approval dialog states exactly what will be written.
  const allergy = review.getByLabel(/Allergy: Sulfa/);
  assert.equal(await allergy.isChecked(), false, "Nothing is selected by default");
  await allergy.check();
  await review.getByRole("button", { name: "Approve and write to chart" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("unconfirmed, reported by the patient").waitFor();
  await dialog.getByText("Nothing that is already in the chart is changed or removed.").waitFor();
  await shot(page, "approve");
  await dialog.getByRole("button", { name: "Approve and write" }).click();
  const result = review.getByRole("region", { name: "Chart result" });
  await result.getByText("Visit note").waitFor();
  // Synthetic data never goes to an EHR: each item is offered as text to copy.
  assert.equal(await result.getByRole("button", { name: "Copy to chart" }).count(), 2);
  assert.equal(await review.getByRole("button", { name: "Approve and write to chart" }).count(), 0, "An approved note cannot be approved again");
  await shot(page, "result");

  await page.getByRole("tab", { name: "History" }).click();
  await page.getByRole("region", { name: "Recorded visits" }).getByRole("button", { name: /Visit note/ }).waitFor();
  assert.deepEqual(errors, [], "No uncaught browser errors");
  console.log("Passed scribe browser flow (fake microphone, deterministic transcription and note stand-ins): consent gate, recording indicator, pause and resume, live upload, sourced note, selected allergy, approval summary, copy-to-chart result, history.");
} finally {
  await browser.close();
}
