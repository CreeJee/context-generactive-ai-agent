import assert from "node:assert/strict";
import { chromium } from "playwright";
import { navigationInterrupt as interruptFor } from "../apps/agent/scripts/navigation-fixtures.ts";

const approvals = process.env.NAV_TEST_APPROVALS === "1";

// Browser-only fixtures: never send a message, change settings, or claim a server lease.
const origin = process.env.NAV_TEST_ORIGIN ?? "http://localhost:5173";
const project = process.env.NAV_TEST_PROJECT;
const session = process.env.NAV_TEST_SESSION;
assert(project && session, "Set NAV_TEST_PROJECT and NAV_TEST_SESSION to an existing session");
const other = "navigation-fixture-b";
const snapshot = await fetch(`${origin}/api/sessions?project=${encodeURIComponent(project)}`).then(
  (response) => response.json(),
);
const template = snapshot.find((item) => item.id === session);
assert(template, "The initial session must be active");
const runTemplate = await fetch(`${origin}/api/sessions/${encodeURIComponent(session)}`).then(
  (response) => response.json(),
);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
let delayed = false;
let releaseLate;
let blockedMutations = 0;
const errors = [];
try {
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/auth") {
      const provider = url.searchParams.get("provider");
      return route.fulfill({
        json: { provider, status: provider === "openai" ? "signed-in" : "signed-out" },
      });
    }
    if (url.pathname === "/api/models") {
      return route.fulfill({
        json: {
          models: [
            {
              id: "navigation-fixture",
              displayName: "Navigation fixture",
              reasoningEfforts: [],
              capabilities: { inputModalities: ["text"], outputModalities: ["text"] },
            },
          ],
          selected: { provider: "openai", model: "navigation-fixture" },
        },
      });
    }
    if (request.method() !== "GET") {
      if (url.pathname.endsWith("/lease")) return route.fulfill({ json: { state: "mine" } });
      blockedMutations++;
      return route.fulfill({ status: 403, json: { error: "Verification blocks mutations" } });
    }
    // Do not route.fetch an endless SSE stream. Empty fixture streams never alter run state.
    if (request.headers().accept?.includes("text/event-stream")) {
      return route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" });
    }
    if (url.pathname === "/api/sessions") {
      return route.fulfill({
        json: url.searchParams.has("archived")
          ? []
          : [
              { ...template, id: session, title: "Navigation A" },
              { ...template, id: other, title: "Navigation B" },
            ],
      });
    }
    const messages = /^\/api\/sessions\/([^/]+)\/messages$/.exec(url.pathname);
    if (messages) {
      const id = decodeURIComponent(messages[1]);
      if (delayed && id === other)
        await new Promise((resolve) => {
          releaseLate = resolve;
        });
      return route.fulfill({
        json: {
          messages: [
            {
              id: `message-${id}`,
              role: "assistant",
              parts: [{ type: "text", content: `NAV-HISTORY-${id}` }],
            },
          ],
          older: null,
          activeRun: null,
          interrupts: approvals ? { runId: `nav-run-${id}`, pending: [interruptFor(id)] } : null,
        },
      });
    }
    if (url.pathname === `/api/sessions/${session}` || url.pathname === `/api/sessions/${other}`) {
      const id = url.pathname.split("/").at(-1);
      return route.fulfill({
        json: {
          ...runTemplate,
          running: null,
          lastRun: {
            runId: `nav-run-${id}`,
            status: approvals ? "interrupted" : "failed",
            error: approvals ? null : { message: `NAV-RUN-${id}` },
          },
          lease: { state: "mine" },
        },
      });
    }
    if (url.pathname.startsWith(`/api/sessions/${other}`)) {
      const response = await route.fetch({ url: request.url().replace(other, session) });
      return route.fulfill({ response });
    }
    return route.continue();
  });
  const page = await context.newPage();
  let documents = 0;
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++;
  });
  page.on("pageerror", (error) => errors.push(error.message));
  const url = (id) =>
    `${origin}/?project=${encodeURIComponent(project)}&session=${encodeURIComponent(id)}`;
  const link = (id) =>
    page.locator(
      `a[href="/?project=${encodeURIComponent(project)}&session=${encodeURIComponent(id)}"]`,
    );
  const history = (id) => page.getByText(`NAV-HISTORY-${id}`, { exact: true });
  const composer = page.locator("textarea").first();
  const approval = (id) => page.getByText(`자동 검토: NAV-APPROVAL-${id}`, { exact: true });
  const run = (id) => page.getByText(`NAV-RUN-${id}`, { exact: false });
  const assertSessionState = async (id, previous) => {
    // Pending approvals intentionally hide terminal run notices in ChatPanel.
    if (!approvals) {
      await run(id).waitFor();
      assert.equal(await run(previous).count(), 0);
    }
    if (approvals) {
      await approval(id).waitFor();
      assert.equal(await approval(previous).count(), 0);
    }
  };
  await page.goto(url(session), { waitUntil: "domcontentloaded" });
  await composer.waitFor({ timeout: 30_000 });
  await history(session).waitFor();
  await assertSessionState(session, other);
  await link(other).waitFor();
  await composer.fill("DRAFT-A");
  await page.evaluate(() => {
    window.__navigationSentinel = true;
  });
  const before = documents;
  await link(other).click();
  await page.waitForURL(url(other));
  await history(other).waitFor();
  await assertSessionState(other, session);
  assert.notEqual(await composer.inputValue(), "DRAFT-A");
  assert.equal(await history(session).count(), 0);
  await composer.fill("DRAFT-B");
  await link(session).click();
  await page.waitForURL(url(session));
  await history(session).waitFor();
  await assertSessionState(session, other);
  assert.equal(await composer.inputValue(), "DRAFT-A");
  await page.goBack();
  await page.waitForURL(url(other));
  await history(other).waitFor();
  await assertSessionState(other, session);
  assert.equal(await composer.inputValue(), "DRAFT-B");
  await page.goForward();
  await page.waitForURL(url(session));
  await history(session).waitFor();
  await assertSessionState(session, other);
  assert.equal(await composer.inputValue(), "DRAFT-A");
  delayed = true;
  await link(other).click();
  await page.waitForURL(url(other));
  await composer.waitFor();
  // Wait for the delayed request to actually start; otherwise the cancellation assertion is vacuous.
  for (let attempt = 0; !releaseLate && attempt < 50; attempt++) await page.waitForTimeout(20);
  assert(releaseLate, "The delayed B history request must be observed");
  await link(session).click();
  await page.waitForURL(url(session));
  await history(session).waitFor();
  await assertSessionState(session, other);
  releaseLate();
  await page.waitForTimeout(500);
  await assertSessionState(session, other);
  assert.equal(await history(other).count(), 0);
  assert.equal(await composer.inputValue(), "DRAFT-A");
  delayed = false;
  const popupPromise = context.waitForEvent("page");
  await link(other).click({ modifiers: ["ControlOrMeta"] });
  const popup = await popupPromise;
  await popup.waitForURL(url(other), { waitUntil: "domcontentloaded" });
  assert.equal(popup.url(), url(other));
  await popup.close();
  assert.equal(await page.evaluate(() => window.__navigationSentinel), true);
  assert.equal(documents - before, 0);
  assert.equal(blockedMutations, 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      fixture: true,
      runIsolation: !approvals,
      approvalIsolation: approvals,
      draftIsolation: true,
      draftRestoration: true,
      historyIsolation: true,
      delayedHistoryIsolation: true,
      newTab: true,
      backForward: true,
      documentRequests: documents - before,
      serverMutations: 0,
    }),
  );
} finally {
  releaseLate?.();
  await context.unrouteAll({ behavior: "ignoreErrors" });
  await browser.close();
}
