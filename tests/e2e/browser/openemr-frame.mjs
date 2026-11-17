// Opt-in check against a REAL OpenEMR (not part of `npm run check` or run-ci.sh): launches StethoLink from the
// chart of a patient created inside that OpenEMR for testing, and checks that it stays inside OpenEMR's window.
// Setup and the commands are in docs/openemr.md ("Checking the embedded frame"). Never point it at real patients.
//
//   OPENEMR_URL=https://localhost:9300 OPENEMR_USER=admin OPENEMR_PASS=... APP_ORIGIN=https://stetholink.test:3082 \
//   APP_NAME=StethoLink OPENEMR_PID=1 [VISIT=none|<encounter number>] [VISIT_REASON="..."] [FRAME_WIDTH=360] [UI=ar] [SHOTS=out] [EXPECT=chart|no-visit|not-shared] \
//   [DRAFT=1] [ORDERS=1|not-set-up] [SCRIBE=1|record] [SCRIBE_AUDIO=visit.wav] [SCRIBE_SECONDS=105] [HISTORY=1] [ORDER_REQUEST="..."] \
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
// A fake microphone, so that no permission prompt hides the frame's own policy. With SCRIBE_AUDIO (a WAV of a FICTIONAL visit, made by
// tests/e2e/browser/scribe-speech.mjs) the fake microphone plays that file once, then silence.
const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${app.hostname} 127.0.0.1`, "--no-proxy-server", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
  ...(env.SCRIBE_AUDIO ? [`--use-file-for-fake-audio-capture=${env.SCRIBE_AUDIO}%noloop`] : [])] });
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
  // OpenEMR goes straight to today's visit when the patient already has one (it replaces the form at once), so the first run of a day
  // shows the form and every later run shows that visit. Either way a visit is then open in the chart; VISIT_REASON applies to a new visit only.
  let form, existing;
  for (let i = 0; i < 160 && !form && !existing; i++) {
    for (const candidate of page.frames()) {
      if (/encounter_top\.php\?set_encounter=|encounter\/forms\.php/.test(candidate.url())) { existing = candidate; break; }
      if (candidate.url().includes("newpatient/new.php") && await candidate.locator("select[name=pc_catid]").count().catch(() => 0)) { form = candidate; break; }
    }
    if (!form && !existing) await page.waitForTimeout(250);
  }
  if (!form && !existing) { await shot(page, "failed-new-visit"); throw new Error(`neither the new-visit form nor an open visit appeared (pass VISIT=<encounter number> to reuse a visit). Frames: ${page.frames().map((frame) => frame.url().replace(emr, "")).join(" | ")}`); }
  if (form) {
    // The form can be shown for a moment before OpenEMR replaces it with today's visit: let it settle, then look again.
    await page.waitForTimeout(3000);
    if (!form.url().includes("newpatient/new.php") || !(await form.locator("select[name=pc_catid]").count().catch(() => 0))) { existing = form; form = undefined; }
  }
  if (existing) console.log("VISIT today's visit was already open: " + (existing.url().match(/set_encounter=(\d+)/)?.[1] ?? "number not shown"));
  else {
    await form.locator("select[name=pc_catid]").selectOption({ label: "Office Visit" }).catch(() => form.locator("select[name=pc_catid]").selectOption({ index: 1 }));
    await form.locator("textarea[name=reason]").fill(env.VISIT_REASON ?? "Follow-up visit (test)");
    await form.locator("#saveEncounter").click();
  }
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
  writeToChart: "الكتابة في الملف", copyToChart: "نسخ إلى الملف", inChart: "في الملف", recording: "جارٍ التسجيل",
  request: "جهّز استشارة قلبية لهذا المريض: هل يحتاج ألم الصدر إلى تقييم عاجل لمتلازمة الشريان التاجي الحادة وما الخطوة الأولى؟",
  answer: "تقييم عاجل: هل تذهب إلى قسم الطوارئ الآن، وما الفحوص التي تأتي أولًا؟",
} : {
  start: "Start recording", refusal: /microphone is not allowed inside the EHR window/i, newWindow: /new window/i,
  prepare: "Prepare consultation", clinicalQuestion: "Clinical question", questions: "The assistant questions this request", answerPlaceholder: "Your answer",
  answerContinue: "Answer and continue", prepareAnyway: "Prepare anyway", approve: "Approve", confirmApprove: "Confirm approve",
  writeToChart: "Write to chart", copyToChart: "Copy to chart", inChart: "In the chart", recording: "Recording",
  request: "Prepare a cardiology consultation for this patient asking whether the chest pain needs urgent evaluation for acute coronary syndrome and what to do first.",
  answer: "Urgent evaluation: should she go to the emergency department now, and which tests come first?",
};
/** The tabs of the panel, left to right in English (the order of Workspace.tsx). */
const TAB = { scribe: 0, consultations: 1, orders: 2, history: 3 };
/** The Orders tab: the names of what the script presses, in the language of the panel (the words of apps/embedded-app/i18n/work.ts, `orders`). */
const O = rtl ? {
  title: "مساعد الأوامر", requestLabel: "ما الأوامر التي تحتاجها؟", request: "جهّز عد دم كامل وأشعة صدر و amoxicillin", prepare: "إعداد الأوامر", draftTitle: "مسودة الأوامر",
  noMatchAria: "لا شيء مطابق", notSetUp: "إعداد الأوامر غير مهيأ", decisionGroup: /^القرار بشأن /, approve: "اعتماد", reasonLabel: "لماذا تطلبه رغم ذلك", reason: "اختبار تجريبي: روجع الأمر مع المريض.",
  record: "تسجيل قراراتي", confirm: "تسجيل القرارات", chartRegion: "في ملف المريض", write: "كتابة الأوامر المعتمدة في الملف", writeConfirm: "كتابة في الملف",
  cannot: "لا يستطيع نظامك الطبي استقبال هذه الأوامر", copyAll: "نسخ الكل كنص",
} : {
  title: "Order assistant", requestLabel: "Which orders do you need?", request: "Prepare a CBC, a chest X-ray and amoxicillin", prepare: "Prepare orders", draftTitle: "Order draft",
  noMatchAria: "Nothing matched", notSetUp: "Order drafting is not set up", decisionGroup: /^Decision for /, approve: "Approve", reasonLabel: "Why you are ordering it anyway", reason: "Fictional test: reviewed with the patient.",
  record: "Record my decisions", confirm: "Record decisions", chartRegion: "In the patient's chart", write: "Write approved orders to the chart", writeConfirm: "Write to chart",
  cannot: "Your EHR cannot receive these orders", copyAll: "Copy all as text",
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
    await frame.getByRole("tab").nth(TAB.scribe).click();
    await frame.getByRole("button", { name: L.start }).first().click();
    await frame.getByRole("checkbox").check();
    await frame.getByRole("dialog").getByRole("button", { name: L.start }).click();
    const refusal = frame.getByText(L.refusal);
    // What the browser decided, not what the frame's attribute suggests: allow="microphone" names the origin of the frame's src (OpenEMR's own
    // launch page), not the page StethoLink serves after the launch redirects, so that spelling can still be refused (docs/openemr.md).
    const recordingNow = frame.getByText(L.recording, { exact: true }).first();
    await refusal.or(recordingNow).first().waitFor({ timeout: 20000 });
    const refused = await refusal.count() > 0;
    if (refused) {
      assert.equal(await frame.getByText(L.newWindow).count(), 0, "the panel still offers a new window");
      await shot(element, name("scribe-blocked"));
    } else await shot(element, name("scribe-recording-start"));
    if (!(attributes.allow && /microphone/.test(attributes.allow))) assert.ok(refused, "the frame has no allow=microphone, yet the browser did not refuse");
    assert.equal(popups.length, 0, "recording opened a window");
    console.log("SCRIBE " + JSON.stringify({ frameAllow: attributes.allow, refused }));
  }
  if (env.SCRIBE === "record") {
    // The whole scribe, inside OpenEMR's frame: consent, recording a FICTIONAL visit (SCRIBE_AUDIO is played by Chromium as its microphone),
    // real transcription of each part, the real note model, the physician's selection and approval, and the write the EHR allows or not.
    // Needs a frame that grants the microphone. OpenEMR 7.0.3 does not (the refusal is the SCRIBE=1 check), so for this mode the throwaway
    // test OpenEMR's dialog.js is changed to add allow="microphone" to the frame it opens (docs/openemr.md); a hospital's OpenEMR would need the same.
    assert.ok(env.SCRIBE_AUDIO, "SCRIBE=record needs SCRIBE_AUDIO, a WAV made by tests/e2e/browser/scribe-speech.mjs");
    assert.ok(attributes.allow && /microphone/.test(attributes.allow), `the frame OpenEMR opened has allow=${JSON.stringify(attributes.allow)}: the microphone is refused; see docs/openemr.md ("Recording inside the frame")`);
    const S = rtl ? {
      start: "بدء التسجيل", recording: "جارٍ التسجيل", transcribed: /تم تفريغ \d+/, end: "إنهاء الزيارة وكتابة الملاحظة", review: "مراجعة ملاحظة الزيارة", noteTitle: /ملاحظة الزيارة/,
      awaiting: "بانتظار مراجعة الطبيب", source: /^المصدر: الزيارة/, quoted: /^اقتباس:/, approveWrite: "اعتماد وكتابة في الملف", confirm: "اعتماد وكتابة", resultTitle: "النتيجة في الملف", newLegend: /جديد/,
    } : {
      start: "Start recording", recording: "Recording", transcribed: /[1-9]\d* parts? transcribed/, end: "End visit and write note", review: "Visit note review", noteTitle: "Visit note (SOAP)",
      awaiting: "Awaiting physician review", source: /^Source: visit/, quoted: /^Quoted:/, approveWrite: "Approve and write to chart", confirm: "Approve and write", resultTitle: "Result in the chart", newLegend: /^New:/,
    };
    const chartBox = frame.locator("button[aria-controls=chart-summary]");
    if (await chartBox.getAttribute("aria-expanded") === "true") await chartBox.click();
    await frame.getByRole("tab").nth(TAB.scribe).click();
    await frame.getByRole("button", { name: S.start }).first().click();
    await frame.getByRole("checkbox").check();
    await shot(element, name("scribe-consent"));
    await frame.getByRole("dialog").getByRole("button", { name: S.start }).click();
    await frame.getByText(S.recording, { exact: true }).first().waitFor({ timeout: 20000 });
    await shot(element, name("scribe-recording"));
    // Parts are cut at a pause after 20 s of sound (30 s at the latest) and transcribed while the visit goes on.
    await frame.getByText(S.transcribed).first().waitFor({ timeout: 90000 });
    console.log("SCRIBE first part transcribed");
    await shot(element, name("scribe-part"));
    await page.waitForTimeout(Number(env.SCRIBE_SECONDS ?? 105) * 1000 - 30000);
    await frame.getByRole("button", { name: S.end }).click();
    const note = frame.getByRole("region", { name: S.review });
    await note.getByRole("heading", { name: S.noteTitle }).waitFor({ timeout: 110000 });
    await note.getByText(S.awaiting).first().waitFor();
    await shot(element, name("scribe-note"));
    // One press on a statement's source shows the words of the visit behind it.
    await note.getByRole("button", { name: S.source }).first().click();
    await note.getByText(S.quoted).first().waitFor();
    await shot(element, name("scribe-source"));
    const statements = await note.getByRole("button", { name: S.source }).count();
    // New chart items start unselected: the physician ticks them (never the allergy confirmation, which the physician alone may give).
    const fresh = note.getByRole("group", { name: S.newLegend });
    let ticked = 0;
    for (const box of await fresh.getByRole("checkbox").all()) {
      const label = await box.evaluate((node) => node.closest("label")?.innerText ?? "");
      if (/confirm this allergy|أؤكد/.test(label)) continue;
      await box.check(); ticked++;
    }
    console.log("SCRIBE note: " + statements + " cited statements, " + ticked + " new chart items ticked");
    await note.getByRole("button", { name: S.approveWrite }).click();
    await frame.getByRole("dialog").waitFor();
    await shot(element, name("scribe-approve"));
    await frame.getByRole("dialog").getByRole("button", { name: S.confirm }).click();
    await note.getByText(S.resultTitle).waitFor({ timeout: 30000 });
    await note.getByText(S.resultTitle).scrollIntoViewIfNeeded();
    await shot(element, name("scribe-result"));
    console.log("SCRIBE result: " + (await note.innerText()).replace(/\s+/g, " ").match(new RegExp(`${S.resultTitle}.{0,500}`))?.[0]);
    assert.equal(popups.length, 0, "the scribe opened a window");
  }
  if (env.DRAFT === "1") {
    // A consultation drafted by the real model from this chart, then the physician's approval dialog. Needs the model
    // configured on the server. The draft goes through the de-identification layer; nothing is sent to a specialist.
    const chartToggle = frame.locator("button[aria-controls=chart-summary]");
    if (await chartToggle.getAttribute("aria-expanded") === "true") await chartToggle.click();
    await frame.getByRole("tab").nth(TAB.consultations).click();
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
      if (env.WRITE !== "0") {
        // The approved consultation into the patient's chart. OpenEMR 7.0.3 has no scope a SMART app can be given to create a
        // DocumentReference (docs/openemr.md), so the write must come back as "not written" with the text to copy, never as a silent success.
        await frame.getByRole("button", { name: L.writeToChart, exact: true }).first().scrollIntoViewIfNeeded();
        await frame.getByRole("button", { name: L.writeToChart, exact: true }).first().click();
        await frame.getByRole("dialog").waitFor();
        await shot(element, name("consultation-write-confirm"));
        await frame.getByRole("dialog").getByRole("button", { name: L.writeToChart }).click();
        const copyButton = frame.getByRole("button", { name: L.copyToChart }).first();
        const inChart = frame.getByText(L.inChart, { exact: true }).first();
        await copyButton.or(inChart).waitFor({ timeout: 30000 });
        const written = await inChart.count() > 0 && await copyButton.count() === 0;
        console.log("CONSULTATION write: " + (written ? "written to the chart" : "not written, text offered to copy"));
        await copyButton.scrollIntoViewIfNeeded().catch(() => undefined);
        await shot(element, name("consultation-write-result"));
        if (!written) {
          await copyButton.click();
          await page.waitForTimeout(500);
          console.log("CONSULTATION after copy: " + (await frame.locator("[role=status]").allInnerTexts()).join(" | ").slice(0, 200));
        }
      }
    }
  }
  if (env.ORDERS === "not-set-up") {
    // The server was started without ORDER_CATALOG_FILE: the tab says order drafting is not set up and offers nothing.
    const chartOpen = frame.locator("button[aria-controls=chart-summary]");
    if (await chartOpen.getAttribute("aria-expanded") === "true") await chartOpen.click();
    await frame.getByRole("tab").nth(TAB.orders).click();
    await frame.getByText(O.notSetUp).waitFor({ timeout: 20000 });
    assert.equal(await frame.getByLabel(O.requestLabel).count(), 0, "the tab still offers a request box");
    await shot(element, name("orders-not-set-up"));
  }
  if (env.ORDERS === "1") {
    // Orders drafted by the real model from the hospital's catalog (ORDER_CATALOG_FILE on the server: the fictional catalog of
    // tests/fixtures/order-catalog.ts), then the physician's decision with its acknowledgement and the write that OpenEMR 7.0.3 cannot
    // take: the approved orders come back as text to enter. Needs the model configured on the server. Nothing is written to OpenEMR.
    const chartToggle = frame.locator("button[aria-controls=chart-summary]");
    if (await chartToggle.getAttribute("aria-expanded") === "true") await chartToggle.click();
    await frame.getByRole("tab").nth(TAB.orders).click();
    await frame.getByRole("heading", { name: O.title }).waitFor({ timeout: 20000 });
    await shot(element, name("orders-start"));
    await frame.getByLabel(O.requestLabel).fill(env.ORDER_REQUEST ?? O.request);
    await frame.getByRole("button", { name: O.prepare }).click();
    await shot(element, name("orders-working"));
    const orderDraft = frame.getByRole("article", { name: O.draftTitle, exact: true });
    const nothing = frame.locator(`section[aria-label="${O.noMatchAria}"]`);
    await orderDraft.or(nothing).or(frame.locator("[role=alert].alert-danger")).first().waitFor({ timeout: 110000 });
    if (!(await orderDraft.count())) {
      console.log("ORDERS no draft: " + (await frame.locator("main").innerText()).slice(0, 300).replace(/\s+/g, " "));
      await shot(element, name("orders-no-match"));
    } else {
      await orderDraft.scrollIntoViewIfNeeded();
      await shot(element, name("orders-draft"));
      const cards = orderDraft.getByRole("article");
      console.log("ORDERS draft: " + (await cards.count()) + " orders");
      // The allergy card, with its check in words.
      const flagged = orderDraft.getByRole("article", { name: /amoxicillin/i });
      if (await flagged.count()) { await flagged.first().scrollIntoViewIfNeeded(); await shot(element, name("orders-flags")); }
      // Approve every order; the allergy needs its acknowledgement and a reason before the decisions can be recorded.
      for (const group of await orderDraft.getByRole("group", { name: O.decisionGroup }).all()) await group.getByRole("button", { name: O.approve, exact: true }).click();
      for (const box of await frame.getByRole("checkbox").all()) await box.check();
      for (const field of await frame.getByLabel(O.reasonLabel).all()) await field.fill(O.reason);
      if (await flagged.count()) { await flagged.first().scrollIntoViewIfNeeded(); await shot(element, name("orders-acknowledge")); }
      const record = frame.getByRole("button", { name: O.record });
      await record.scrollIntoViewIfNeeded();
      await record.click();
      await frame.getByRole("dialog").waitFor();
      await shot(element, name("orders-confirm"));
      await frame.getByRole("dialog").getByRole("button", { name: O.confirm }).click();
      const panel = frame.getByRole("region", { name: O.chartRegion });
      await panel.waitFor({ timeout: 20000 });
      await panel.scrollIntoViewIfNeeded();
      await shot(element, name("orders-approved"));
      await panel.getByRole("button", { name: O.write }).click();
      await frame.getByRole("dialog").waitFor();
      await shot(element, name("orders-write-confirm"));
      await frame.getByRole("dialog").getByRole("button", { name: O.writeConfirm }).click();
      await panel.getByText(O.cannot).waitFor({ timeout: 30000 });
      await panel.scrollIntoViewIfNeeded();
      await shot(element, name("orders-cannot-receive"));
      // Inside OpenEMR's frame the clipboard may be blocked: the panel says so instead of failing without a word.
      await panel.getByRole("button", { name: O.copyAll }).click().catch(() => undefined);
      await page.waitForTimeout(500);
      console.log("ORDERS after copy: " + (await panel.locator("[role=status]").allInnerTexts()).join(" | "));
      assert.equal(popups.length, 0, "the orders opened a window");
    }
  }
  if (env.HISTORY === "1") {
    // The History tab: the consultations of this visit (after DRAFT=1 there is one) and the recorded visits.
    await frame.getByRole("tab").nth(TAB.history).click();
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
    await frame.getByRole("tab").nth(TAB.history).click();
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
