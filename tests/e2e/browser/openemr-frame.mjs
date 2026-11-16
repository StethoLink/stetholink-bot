// Opt-in check against a REAL OpenEMR (not part of `npm run check` or run-ci.sh): launches StethoLink from the
// chart of a patient created inside that OpenEMR for testing, and checks that it stays inside OpenEMR's window.
// Setup and the commands are in docs/openemr.md ("Checking the embedded frame"). Never point it at real patients.
//
//   OPENEMR_URL=https://localhost:9300 OPENEMR_USER=admin OPENEMR_PASS=... APP_ORIGIN=https://stetholink.test:3082 \
//   APP_NAME=StethoLink OPENEMR_PID=1 [VISIT=none|<encounter number>] [FRAME_WIDTH=360] [UI=ar] [SHOTS=out] [EXPECT=chart|no-visit|not-shared] \
//   NODE_PATH=/opt/node-tools/node_modules node tests/e2e/browser/openemr-frame.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");

const env = process.env;
const emr = new URL(env.OPENEMR_URL).origin;
const app = new URL(env.APP_ORIGIN);
const expectState = env.EXPECT ?? "chart";
const width = Number(env.FRAME_WIDTH ?? 0);
const shot = async (target, name) => { if (env.SHOTS) await target.screenshot({ path: `${env.SHOTS}/${name}.png` }); };

// A test host name that is a different site from OpenEMR's resolves to this machine.
// A fake microphone, so that no permission prompt hides the frame's own policy.
const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${app.hostname} 127.0.0.1`, "--no-proxy-server", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 }, locale: "en-US", deviceScaleFactor: env.SHOTS ? 2 : 1 });
const popups = [];
const page = await context.newPage();
// Any further window or tab, opened by anyone, is counted.
context.on("page", (opened) => { popups.push(opened); if (env.DEBUG) opened.waitForLoadState().then(() => console.log("POPUP", opened.url())).catch(() => undefined); });
/** Every request made by a StethoLink document, and every StethoLink response's policy. */
const outside = [];
const policies = new Set();
page.on("request", (request) => {
  const from = request.frame().url();
  if (from.startsWith(app.origin) && !request.url().startsWith(app.origin + "/") && !request.url().startsWith("data:") && !request.url().startsWith("blob:")
    // The launch itself: StethoLink redirects the frame to the EHR's own sign-in page, and nowhere else.
    && !(request.isNavigationRequest() && request.url().startsWith(emr + "/"))) outside.push(request.url());
});
if (env.DEBUG) {
  page.on("requestfailed", (request) => console.log("FAILED", request.url().slice(0, 120), request.failure()?.errorText));
  page.on("console", (message) => { if (message.type() === "error") console.log("CONSOLE", message.text().slice(0, 300)); });
  page.on("framenavigated", (frame) => { if (frame.parentFrame()) console.log("NAV", frame.url().slice(0, 100)); });
}
page.on("response", (response) => { if (response.url().startsWith(app.origin)) policies.add(response.headers()["content-security-policy"] ?? "MISSING"); });

await page.goto(`${emr}/interface/login/login.php?site=default`);
await page.fill("#authUser", env.OPENEMR_USER);
await page.fill("#clearPass", env.OPENEMR_PASS);
await Promise.all([page.waitForNavigation(), page.click("#login-button")]);
await page.waitForLoadState("networkidle");
// OpenEMR's product registration dialog: "Ask again later" (never submitted).
for (const frame of page.frames()) await frame.locator("text=Ask again later").first().click({ timeout: 1500 }).catch(() => undefined);

const pid = env.OPENEMR_PID ?? "1";
await page.evaluate((id) => window.navigateTab(`${window.webroot_url}/interface/patient_file/summary/demographics.php?set_pid=${id}`, "pat", () => window.activateTabByName("pat", true)), pid);
const dashboard = async () => {
  for (let i = 0; i < 60; i++) {
    const frame = page.frames().find((candidate) => candidate.url().includes("demographics.php"));
    if (frame && await frame.locator(".smart-launch-btn").count()) return frame;
    await page.waitForTimeout(500);
  }
  throw new Error("The patient dashboard with SMART apps did not load");
};
let chart = await dashboard();
const reopenDashboard = async () => {
  await page.waitForTimeout(3000);
  await page.evaluate((id) => window.navigateTab(`${window.webroot_url}/interface/patient_file/summary/demographics.php?set_pid=${id}`, "pat", () => window.activateTabByName("pat", true)), pid);
  await page.waitForTimeout(1500);
  return dashboard();
};
if (/^\d+$/.test(env.VISIT ?? "")) {
  // Open an existing visit of the test patient (VISIT=<encounter number>).
  await page.waitForTimeout(2000);
  await page.evaluate((id) => window.navigateTab(`${window.webroot_url}/interface/patient_file/encounter/encounter_top.php?set_encounter=${id}`, "enc", () => window.activateTabByName("enc", true)), env.VISIT);
  chart = await reopenDashboard();
} else if (env.VISIT !== "none") {
  // Open a visit the way a clinician does: the new-visit form, saved.
  await page.waitForTimeout(3000);
  await page.evaluate(() => window.navigateTab(`${window.webroot_url}/interface/forms/newpatient/new.php?autoloaded=1&calenc=`, "enc", () => window.activateTabByName("enc", true)));
  let form;
  for (let i = 0; i < 80 && !form; i++) { form = page.frames().find((candidate) => candidate.url().includes("newpatient/new.php")); if (!form) await page.waitForTimeout(500); }
  await form.locator("select[name=pc_catid]").waitFor();
  await form.locator("select[name=pc_catid]").selectOption({ label: "Office Visit" }).catch(() => form.locator("select[name=pc_catid]").selectOption({ index: 1 }));
  await form.locator("textarea[name=reason]").fill("Follow-up visit (test)");
  await form.locator("#saveEncounter").click();
  chart = await reopenDashboard();
}
// The app's own Launch button on the dashboard. The "SMART Enabled Apps" card may be collapsed, so the button is
// pressed through the page rather than by pointer position.
const launch = chart.locator(`.smart-launch-btn[data-smart-name="${env.APP_NAME ?? "StethoLink"}"]`);
assert.equal(await launch.count(), 1, "the app is not listed once on the patient dashboard (registered, enabled, launch scope?)");
await launch.evaluate((button) => button.click());

const inApp = (frame) => frame.url().startsWith(app.origin);
const appFrame = async () => {
  const answered = new Set();
  for (const deadline = Date.now() + 60000; Date.now() < deadline;) {
    const signIn = page.frames().find((frame) => frame.url().includes("/oauth2/") );
    if (signIn) {
      // OpenEMR's own sign-in and consent, inside the same frame: each page is answered once.
      const user = signIn.locator("input[type=text][name=username]");
      const authorize = signIn.locator("button[name=proceed]");
      if (await user.isVisible().catch(() => false) && !answered.has("login")) {
        answered.add("login");
        await user.fill(env.OPENEMR_USER);
        await signIn.fill("input[type=password][name=password]", env.OPENEMR_PASS);
        await signIn.locator("button[name=user_role][value=api]:visible").first().click();
      } else if (await authorize.isVisible().catch(() => false) && !answered.has("consent")) {
        answered.add("consent");
        await authorize.click();
      }
    }
    const frame = page.frames().find((candidate) => inApp(candidate) && !candidate.url().includes("/api/smart/launch"));
    if (frame && await frame.locator("main, [role=alert]").count().catch(() => 0)) return frame;
    await page.waitForTimeout(500);
  }
  await shot(page, "failed");
  throw new Error(`StethoLink did not appear in a frame. Frames: ${page.frames().map((frame) => frame.url()).join(" | ")}`);
};
const frame = await appFrame();

// Inside OpenEMR: the document is a child frame of OpenEMR's page, in the one window there is.
assert.equal(popups.length, 0, `a new window was opened: ${popups.map((opened) => opened.url())}`);
assert.equal(context.pages().length, 1);
assert.notEqual(frame.parentFrame(), null);
assert.ok(page.url().startsWith(emr), "the outer window left OpenEMR");
let top = frame; while (top.parentFrame()) top = top.parentFrame();
assert.ok(top.url().startsWith(emr));
const element = await frame.frameElement();
const attributes = await element.evaluate((node) => ({ allow: node.getAttribute("allow"), sandbox: node.getAttribute("sandbox"), width: node.getBoundingClientRect().width }));
if (width) {
  // A narrow side panel: the frame OpenEMR created is narrowed to the width under test.
  await element.evaluate((node, value) => {
    for (const property of ["width", "min-width", "max-width"]) node.style.setProperty(property, `${value}px`, "important");
    node.style.setProperty("flex", "none", "important");
  }, width);
  await page.waitForTimeout(400);
  assert.equal(await frame.evaluate(() => window.innerWidth), width, "the frame did not take the width under test");
  attributes.width = (await element.boundingBox()).width;
}

if (env.UI === "ar") {
  await frame.locator("button[lang=ar]").click();
  await frame.locator("html[dir=rtl]").waitFor();
}
const rtl = env.UI === "ar";
/** The names of the controls the script presses, in the language of the panel (the words of apps/embedded-app/i18n/work.ts). */
const L = rtl ? {
  start: "بدء التسجيل", refusal: /الميكروفون غير مسموح به داخل نافذة النظام الطبي/, newWindow: /نافذة جديدة/,
  prepare: "إعداد الاستشارة", clinicalQuestion: "السؤال السريري", questions: "المساعد يستوضح هذا الطلب", answerPlaceholder: "إجابتك",
  answerContinue: "أجب وتابع", prepareAnyway: "أعدّها على أي حال", approve: "اعتماد", confirmApprove: "تأكيد الاعتماد",
  request: "جهّز استشارة قلبية لهذا المريض: هل يحتاج ألم الصدر إلى تقييم عاجل لمتلازمة الشريان التاجي الحادة وما الخطوة الأولى؟",
  answer: "تقييم عاجل: هل تذهب إلى قسم الطوارئ الآن، وما الفحوص التي تأتي أولًا؟",
} : {
  start: "Start recording", refusal: /microphone is not allowed inside the EHR window/i, newWindow: /new window/i,
  prepare: "Prepare consultation", clinicalQuestion: "Clinical question", questions: "The assistant questions this request", answerPlaceholder: "Your answer",
  answerContinue: "Answer and continue", prepareAnyway: "Prepare anyway", approve: "Approve", confirmApprove: "Confirm approve",
  request: "Prepare a cardiology consultation for this patient asking whether the chest pain needs urgent evaluation for acute coronary syndrome and what to do first.",
  answer: "Urgent evaluation: should she go to the emergency department now, and which tests come first?",
};
const name = (base) => `${base}${rtl ? "-ar" : ""}-${width || "wide"}`;
if (expectState === "no-visit") {
  const alert = frame.locator("[data-state=no-open-visit]");
  await alert.waitFor();
  assert.match(await alert.innerText(), /Open a visit in the patient.s chart, then launch StethoLink again\.|افتح زيارة في ملف المريض/);
  assert.match(await alert.locator("code").innerText(), /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
  await shot(element, name("no-open-visit"));
} else {
  await frame.locator("header h2").first().waitFor({ timeout: 20000 }).catch(async (error) => { await shot(page, "failed"); console.log("PANEL " + (await frame.locator("body").innerText()).slice(0, 400)); throw error; });
  const patient = await frame.locator("header h2").first().innerText();
  assert.ok(patient.trim().length > 0);
  // Nothing wider than the frame: no sideways scrolling at this width.
  const overflow = await frame.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `the panel is ${overflow}px wider than its frame`);
  assert.equal(await frame.evaluate(() => document.fonts.ready.then(() => [...document.fonts].filter((font) => font.status === "loaded").length > 0)), true, "the application's own font did not load");
  await shot(element, name(expectState === "not-shared" ? "not-shared" : "workspace"));
  // The whole OpenEMR window, to show where the panel sits.
  await shot(page, name("openemr-window"));
  if (expectState === "not-shared") {
    await frame.locator("[data-state=not-shared]").first().waitFor();
  } else assert.equal(await frame.locator("[data-state=not-shared]").count(), 0);
  await frame.locator("button[aria-controls=chart-summary]").click();
  await frame.locator("#chart-summary").waitFor();
  await shot(element, name(expectState === "not-shared" ? "not-shared-chart" : "chart"));
  // Keyboard: the first Tab lands on a control with a visible focus ring.
  await frame.locator("button[aria-controls=chart-summary]").focus();
  await page.keyboard.press("Tab");
  const ring = await frame.evaluate(() => { const node = document.activeElement; const style = getComputedStyle(node); return { tag: node.tagName, outline: style.outlineStyle, width: style.outlineWidth }; });
  assert.notEqual(ring.outline, "none", `no focus ring on ${ring.tag}`);
  // The session cookie as the browser stored it.
  const cookies = (await context.cookies()).filter((cookie) => cookie.domain === app.hostname);
  console.log(JSON.stringify({ patientShown: true, cookies: cookies.map(({ name: cookie, sameSite, secure, httpOnly, partitionKey }) => ({ cookie, sameSite, secure, httpOnly, partitioned: !!partitionKey })) }));
  if (env.SCRIBE === "1") {
    // The recorder inside OpenEMR's frame. OpenEMR does not put allow="microphone" on it, so the browser refuses the
    // microphone: the panel must say so and offer no new window (it used to offer one).
    await frame.getByRole("tab").nth(0).click();
    await frame.getByRole("button", { name: L.start }).first().click();
    await frame.getByRole("checkbox").check();
    await frame.getByRole("dialog").getByRole("button", { name: L.start }).click();
    const refusal = frame.getByText(L.refusal);
    if (attributes.allow && /microphone/.test(attributes.allow)) await frame.getByText(/Recording|Pause/).first().waitFor();
    else {
      await refusal.waitFor({ timeout: 20000 });
      assert.equal(await frame.getByText(L.newWindow).count(), 0, "the panel still offers a new window");
      await shot(element, name("scribe-blocked"));
    }
    assert.equal(popups.length, 0, "recording opened a window");
    console.log("SCRIBE " + JSON.stringify({ frameAllow: attributes.allow, refused: !(attributes.allow && /microphone/.test(attributes.allow)) }));
  }
  if (env.DRAFT === "1") {
    // A consultation drafted by the real model from this chart, then the physician's approval dialog. Needs the model
    // configured on the server. The draft goes through the de-identification layer; nothing is sent to a specialist.
    const chartToggle = frame.locator("button[aria-controls=chart-summary]");
    if (await chartToggle.getAttribute("aria-expanded") === "true") await chartToggle.click();
    await frame.getByRole("tab").nth(1).click();
    await frame.getByRole("textbox").first().fill(env.DRAFT_REQUEST ?? L.request);
    await frame.getByRole("button", { name: L.prepare }).click();
    await shot(element, name("draft-working"));
    const draftHeading = frame.locator(`h3:has-text("${L.clinicalQuestion}")`);
    const questions = frame.locator(`section[aria-label="${L.questions}"]`);
    await draftHeading.or(questions).or(frame.locator("[role=alert].alert-danger")).first().waitFor({ timeout: 110000 });
    let outcome = await draftHeading.count() ? "draft" : await questions.count() ? "questions" : "alert";
    // The model asks before it drafts a vague request. Answer once, then accept what it still doubts ("Prepare anyway").
    for (let round = 0; round < 2 && outcome === "questions"; round++) {
      console.log("DRAFT questions");
      await shot(element, name(`draft-questions${round || ""}`));
      const answer = frame.getByPlaceholder(L.answerPlaceholder).first();
      if (round === 0 && await answer.count()) {
        await answer.fill(L.answer);
        await frame.getByRole("button", { name: L.answerContinue }).click();
      } else await frame.getByRole("button", { name: L.prepareAnyway }).click();
      await draftHeading.or(questions).or(frame.locator("[role=alert].alert-danger")).first().waitFor({ timeout: 110000 });
      outcome = await draftHeading.count() ? "draft" : await questions.count() ? "questions" : "alert";
    }
    if (outcome === "draft") {
      await draftHeading.scrollIntoViewIfNeeded();
      await shot(element, name("draft"));
      await frame.getByRole("button", { name: L.approve, exact: true }).click();
      await frame.getByRole("dialog").locator("select").selectOption({ index: 1 });
      await shot(element, name("approve-dialog"));
      await frame.getByRole("button", { name: L.confirmApprove }).click();
      await frame.getByRole("heading", { name: /Send to/ }).or(frame.getByRole("button", { name: /^Send/ })).first().waitFor({ timeout: 30000 }).catch(() => undefined);
      await shot(element, name("approved"));
    }
  }
  if (env.HISTORY === "1") {
    // The History tab: the consultations of this visit (after DRAFT=1 there is one) and the recorded visits.
    await frame.getByRole("tab").nth(2).click();
    await frame.locator("section[aria-label], [role=tabpanel] ul, [role=tabpanel] [role=status]").first().waitFor({ timeout: 20000 });
    await page.waitForTimeout(800);
    await shot(element, name("history"));
  }
  if (env.BREAK_HOOK) {
    // The caller stops a dependency now (for example the database: `docker stop <db>`), within BREAK_HOOK milliseconds.
    // The panel must then show the failure with the reference the server logged.
    console.log("BREAK_NOW");
    await page.waitForTimeout(Number(env.BREAK_HOOK));
    await frame.locator("button[aria-controls=chart-summary]").click();
    await frame.getByRole("tab").nth(2).click();
    const reference = frame.getByText(/[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}/).first();
    await reference.waitFor({ timeout: 30000 });
    console.log("REFERENCE " + (await reference.innerText()).match(/[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}/)[0]);
    await shot(element, name("error-reference"));
  }
}
assert.deepEqual(outside, [], "a StethoLink page asked for something outside its own origin");
assert.ok(policies.size > 0 && ![...policies].some((policy) => policy === "MISSING" || !policy.includes(`frame-ancestors ${emr}`)), `policy missing or wrong: ${[...policies].slice(0, 2)}`);
console.log(JSON.stringify({ ok: true, browser: `Chromium ${browser.version()}`, state: expectState, sameSite: app.hostname === new URL(emr).hostname, frame: attributes, popups: popups.length, outsideRequests: outside.length, appUrl: new URL(frame.url()).pathname }));
await browser.close();
