/// <reference lib="dom" />
import assert from "node:assert/strict";
import { chromium, type CDPSession } from "playwright";
import { Schema } from "effect";

const origin = "http://localhost:5173";
const uiMode = process.env.UI_HISTORY_MODE;
const uiArguments = JSON.stringify({ fixture: "UI-COST-ARGS", payload: "x".repeat(128 * 1024) });
const uiResult = JSON.stringify({ fixture: "UI-COST-RESULT", payload: "y".repeat(128 * 1024) });
declare global {
  interface Window {
    uiCostProbe: {
      arguments: number;
      results: number;
      parseMs: number;
      phases: { name: string; startTime: number; duration: number; hydrating: boolean }[];
      depths: Record<string, number>;
      historyDeliveredAt: number;
      longTasks: { startTime: number; duration: number }[];
      commits: {
        phase: string;
        actualDuration: number;
        baseDuration: number;
        startTime: number;
        commitTime: number;
      }[];
    };
  }
}
const records = Schema.decodeUnknownSync(
  Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
);
const record = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
const projects = records(await (await fetch(`${origin}/api/projects`)).json());
const project = projects.find((item) => item.root === process.cwd()) ?? projects[0];
const { id: projectId } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.NonEmptyString }))(
  project,
);
const sessions = records(
  await (await fetch(`${origin}/api/sessions?project=${encodeURIComponent(projectId)}`)).json(),
);
const template = sessions[0];
const { id: a } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.NonEmptyString }))(template);
const b = "parallel-fixture-b";
const run = record(await (await fetch(`${origin}/api/sessions/${encodeURIComponent(a)}`)).json());
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const trace: { endpoint: string; at: number }[] = [];
let cdp: CDPSession | undefined;
const decodeMetrics = Schema.decodeUnknownSync(
  Schema.Struct({
    metrics: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.Number })),
  }),
);
let deliveryMetrics: ReturnType<typeof decodeMetrics> | undefined;
let releaseModels: (() => void) | undefined;
let releaseHistory: (() => void) | undefined;
let delayedHistory = false;
let firstHistoryCompletedAt: number | undefined;
let posts = 0;
const errors: string[] = [];
const start = performance.now();
try {
  if (uiMode) {
    await context.addInitScript(() => {
      window.uiCostProbe = {
        arguments: 0,
        results: 0,
        parseMs: 0,
        phases: [],
        depths: {},
        commits: [],
        historyDeliveredAt: 0,
        longTasks: [],
      };
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          window.uiCostProbe.longTasks.push({
            startTime: entry.startTime,
            duration: entry.duration,
          });
      }).observe({ type: "longtask", buffered: true });
      const original = JSON.parse;
      JSON.parse = (text, reviver) => {
        const argument = text.startsWith('{"fixture":"UI-COST-ARGS"');
        const result = text.startsWith('{"fixture":"UI-COST-RESULT"');
        const at = performance.now();
        const value = original(text, reviver);
        if (argument) window.uiCostProbe.arguments++;
        if (result) window.uiCostProbe.results++;
        if (argument || result) window.uiCostProbe.parseMs += performance.now() - at;
        return value;
      };
    });
    // Browser-only boundary wrappers retain original arguments/this/returns and
    // log only outermost recursive calls. Timings are inclusive per boundary;
    // hydration work may contain commit work and is never added to it.
    const phaseWrapper = (source: string, name: string, hydrationRoot: boolean) => {
      const declaration = `function ${name}(`;
      assert.equal(source.split(declaration).length, 2, `${name} boundary must exist exactly once`);
      const original = `UIOriginal_${name}`;
      const wrapper = `function ${name}(...args) { const probe=window.uiCostProbe; const depth=probe.depths[${JSON.stringify(name)}] || 0; probe.depths[${JSON.stringify(name)}]=depth+1; const startTime=performance.now(); const hydrating=${hydrationRoot ? "!!args[0]?.current?.memoizedState?.isDehydrated" : "false"}; try { return ${original}.apply(this,args); } finally { probe.depths[${JSON.stringify(name)}]=depth; if (depth===0) probe.phases.push({name:${JSON.stringify(name)},startTime,duration:performance.now()-startTime,hydrating}); } }\n`;
      return source.replace(declaration, `${wrapper}function ${original}(`);
    };
    await context.route("**/@tanstack_ai-react.js*", async (route) => {
      const response = await route.fetch();
      const source = phaseWrapper(await response.text(), "normalizeMessagesDates", false);
      await route.fulfill({ response, body: source });
    });
    await context.route("**/processor-*.js*", async (route) => {
      const response = await route.fetch();
      const source = await response.text();
      const declaration = "setMessages(messages) {";
      assert.equal(source.split(declaration).length, 2);
      const wrapper = `setMessages(...args) { const startTime=performance.now(); try { return this.UIOriginal_setMessages(...args); } finally { window.uiCostProbe.phases.push({ name:"processor.setMessages",startTime,duration:performance.now()-startTime,hydrating:false }); } }\nUIOriginal_setMessages(messages) {`;
      await route.fulfill({ response, body: source.replace(declaration, wrapper) });
    });
    await context.route("**/react-dom_client.js*", async (route) => {
      const response = await route.fetch();
      let source = await response.text();
      for (const name of [
        "performWorkOnRoot",
        "commitRoot",
        "commitMutationEffectsOnFiber",
        "commitLayoutEffectOnFiber",
      ])
        source = phaseWrapper(source, name, name === "performWorkOnRoot" || name === "commitRoot");
      await route.fulfill({ response, body: source });
    });
    await context.route("**/message.tsx*", async (route) => {
      const response = await route.fetch();
      let source = await response.text();
      assert.equal(
        source.split("open &&").length,
        2,
        "Historical eager-detail transform must apply exactly once",
      );
      const react = source.match(/const useState = ([\w$]+)\["useState"\]/)?.[1];
      assert(react, "Profiler must use the same actual React module");
      assert.equal(source.split("function MessageView(").length, 2);
      source = source.replace("export function MessageView(", "function UIOriginalMessageView(");
      if (uiMode === "before") source = source.replace("open &&", "true &&");
      source += `\nexport function MessageView(props) { return ${react}.createElement(${react}.Profiler, { id: "fixed-history", onRender: (id, phase, actualDuration, baseDuration, startTime, commitTime) => window.uiCostProbe.commits.push({ phase, actualDuration, baseDuration, startTime, commitTime }) }, ${react}.createElement(UIOriginalMessageView, props)); }\n`;
      await route.fulfill({ response, body: source });
    });
  }
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    trace.push({ endpoint: url.pathname, at: performance.now() - start });
    if (url.pathname === "/api/auth")
      return route.fulfill({
        json: {
          provider: url.searchParams.get("provider"),
          status: url.searchParams.get("provider") === "openai" ? "signed-in" : "signed-out",
        },
      });
    if (url.pathname === "/api/models") {
      await new Promise<void>((resolve) => {
        releaseModels = resolve;
      });
      return route.fulfill({ status: 503, json: { error: "Delayed catalog fixture" } });
    }
    if (request.method() !== "GET") {
      if (url.pathname.endsWith("/lease")) return route.fulfill({ json: { state: "mine" } });
      posts++;
      return route.fulfill({ status: 403, json: { error: "Blocked fixture mutation" } });
    }
    if (request.headers().accept?.includes("text/event-stream"))
      return route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" });
    if (url.pathname === "/api/sessions")
      return route.fulfill({
        json: url.searchParams.has("archived")
          ? []
          : [
              { ...template, id: a, title: "Parallel A" },
              { ...template, id: b, title: "Parallel B" },
            ],
      });
    if (url.pathname === "/api/chat") {
      const id = url.searchParams.get("threadId") ?? url.searchParams.get("session");
      if (id === b && delayedHistory)
        await new Promise<void>((resolve) => {
          releaseHistory = resolve;
        });
      // Keep actual history I/O pending while independent auth/catalog starts.
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      if (cdp && deliveryMetrics === undefined) {
        deliveryMetrics = decodeMetrics(await cdp.send("Performance.getMetrics"));
        await cdp.send("Runtime.evaluate", {
          expression: "window.uiCostProbe.historyDeliveredAt = performance.now()",
        });
      }
      await route.fulfill({
        json: {
          messages: [
            {
              id: `fixture-${id}`,
              role: "assistant",
              parts: [
                { type: "text", content: `PARALLEL-HISTORY-${id}` },
                ...(uiMode
                  ? Array.from({ length: 20 }, (_, index) => [
                      {
                        type: "tool-call",
                        id: `ui-tool-${index}`,
                        name: "read_file",
                        arguments: uiArguments,
                        state: "input-complete",
                      },
                      {
                        type: "tool-result",
                        toolCallId: `ui-tool-${index}`,
                        content: uiResult,
                        state: "complete",
                      },
                    ]).flat()
                  : []),
              ],
            },
          ],
          activeRun: null,
          interrupts: null,
        },
      });
      firstHistoryCompletedAt ??= performance.now() - start;
      return;
    }
    if (url.pathname === `/api/sessions/${a}` || url.pathname === `/api/sessions/${b}`)
      return route.fulfill({
        json: { ...run, running: null, lastRun: null, lease: { state: "mine" } },
      });
    if (url.pathname.startsWith(`/api/sessions/${b}`))
      return route.fulfill({ response: await route.fetch({ url: request.url().replace(b, a) }) });
    return route.continue();
  });
  const page = await context.newPage();
  if (uiMode) {
    cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
  }
  page.on("pageerror", (error) => errors.push(error.message));
  const url = (id: string) =>
    `${origin}/?project=${encodeURIComponent(projectId)}&session=${encodeURIComponent(id)}`;
  const history = (id: string) => page.getByText(`PARALLEL-HISTORY-${id}`, { exact: true });
  const link = (id: string) =>
    page.locator(
      `a[href="/?project=${encodeURIComponent(projectId)}&session=${encodeURIComponent(id)}"]`,
    );
  await page.goto(url(a), { waitUntil: "domcontentloaded" });
  await history(a).waitFor({ timeout: 30000 });
  assert(releaseModels, "Catalog request must start before checking its deferred completion");
  const catalogStartedAt = trace.find((entry) => entry.endpoint === "/api/models")?.at;
  assert(
    catalogStartedAt !== undefined &&
      firstHistoryCompletedAt !== undefined &&
      catalogStartedAt < firstHistoryCompletedAt,
    "Catalog and history requests must overlap before either blocks rendering",
  );
  assert(await page.getByText("Context Agent", { exact: true }).isVisible());
  assert(trace.some((entry) => entry.endpoint === "/api/chat"));
  if (uiMode) {
    // Allow the observer to report the task that mounted the ready record.
    await page.waitForTimeout(100);
    const collapsed = await page.evaluate(() => ({ ...window.uiCostProbe }));
    assert(collapsed.historyDeliveredAt > 0);
    assert(collapsed.phases.some((phase) => phase.name === "normalizeMessagesDates"));
    assert(collapsed.phases.some((phase) => phase.name === "processor.setMessages"));
    assert(collapsed.phases.some((phase) => phase.name === "commitMutationEffectsOnFiber"));
    assert(
      collapsed.phases.some((phase) => phase.hydrating),
      "Initial SSR hydration boundaries must actually be observed",
    );
    const phaseSummary = [
      "performWorkOnRoot",
      "commitRoot",
      "commitMutationEffectsOnFiber",
      "commitLayoutEffectOnFiber",
      "normalizeMessagesDates",
      "processor.setMessages",
    ].map((name) => {
      const history = collapsed.phases.filter(
        (phase) => phase.name === name && phase.startTime >= collapsed.historyDeliveredAt,
      );
      const hydration = collapsed.phases.filter((phase) => phase.name === name && phase.hydrating);
      return {
        name,
        historyCount: history.length,
        historyMs: history.reduce((sum, phase) => sum + phase.duration, 0),
        hydrationCount: hydration.length,
        hydrationMs: hydration.reduce((sum, phase) => sum + phase.duration, 0),
      };
    });
    const recordLongTasks = collapsed.longTasks.filter(
      (task) => task.startTime >= collapsed.historyDeliveredAt,
    );
    assert(cdp && deliveryMetrics);
    const shownMetrics = decodeMetrics(await cdp.send("Performance.getMetrics"));
    const browserDelta = [
      "ScriptDuration",
      "TaskDuration",
      "LayoutDuration",
      "RecalcStyleDuration",
      "LayoutCount",
    ].map((name) => {
      const startValue = deliveryMetrics?.metrics.find((metric) => metric.name === name)?.value;
      const endValue = shownMetrics.metrics.find((metric) => metric.name === name)?.value;
      assert(startValue !== undefined && endValue !== undefined);
      return { name, value: (endValue - startValue) * (name.endsWith("Duration") ? 1000 : 1) };
    });
    const buttons = page
      .getByRole("button")
      .filter({ has: page.locator("code", { hasText: "read_file" }) });
    assert.equal(await buttons.count(), 20);
    assert(
      collapsed.commits.some((commit) => commit.phase === "mount"),
      "Actual React mount profiling must run",
    );
    if (uiMode === "after")
      assert.equal(collapsed.arguments, 0, "Closed tool arguments must not be parsed");
    if (uiMode === "before")
      assert(collapsed.arguments >= 20, "Historical eager details must really execute");
    await buttons.first().click();
    await page.getByText("인자", { exact: true }).waitFor();
    const opened = await page.evaluate(() => ({ ...window.uiCostProbe }));
    if (uiMode === "after")
      assert(opened.arguments > collapsed.arguments, "Opening must restore full argument details");
    await buttons.first().click();
    assert.equal(await page.getByText("인자", { exact: true }).count(), 0);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    console.log(
      JSON.stringify({
        uiMode,
        fixedTools: 20,
        phaseSummary,
        recordLongTasks,
        browserDelta,
        bootstrapBeforeHistory: deliveryMetrics,
        argumentBytes: Buffer.byteLength(uiArguments),
        resultBytes: Buffer.byteLength(uiResult),
        collapsed: {
          arguments: collapsed.arguments,
          results: collapsed.results,
          parseMs: collapsed.parseMs,
          commits: collapsed.commits,
        },
        opened: {
          arguments: opened.arguments,
          results: opened.results,
          parseMs: opened.parseMs,
          commits: opened.commits,
        },
        openClose: true,
        scope:
          "same fixture/API/body; browser-only historical eager-guard replay and identical React Profiler wrappers; parse time and actual React render duration/commit timestamps, not DOM commit duration/layout/SSR hydration",
      }),
    );
  }
  await link(b).click();
  await history(b).waitFor();
  assert.equal(await history(a).count(), 0);
  await link(a).click();
  await history(a).waitFor();
  delayedHistory = true;
  await link(b).click();
  for (let i = 0; !releaseHistory && i < 100; i++) await page.waitForTimeout(20);
  assert(releaseHistory, "Delayed history must actually start");
  await link(a).click();
  await history(a).waitFor();
  releaseHistory();
  releaseModels();
  await page.waitForTimeout(750);
  assert.equal(await history(b).count(), 0);
  assert(await history(a).isVisible(), "Catalog failure must not hide ready history");
  assert.equal(posts, 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      result: "passed",
      historyBeforeCatalogCompletion: true,
      shellVisible: true,
      catalogErrorDoesNotHideHistory: true,
      lateHistoryIsolation: true,
      mutations: posts,
      pageErrors: errors,
      requestStarts: trace.filter((item) =>
        ["/api/auth", "/api/models", "/api/projects", "/api/chat"].includes(item.endpoint),
      ),
    }),
  );
} finally {
  releaseHistory?.();
  releaseModels?.();
  // Ignore only callbacks canceled by teardown, after all UI assertions finish.
  await context.unrouteAll({ behavior: "ignoreErrors" });
  await context.close();
  await browser.close();
}
