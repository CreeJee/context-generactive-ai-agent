import { layer } from "@effect/vitest";
import {
  maxIterations,
  toolDefinition,
  type ChatMiddlewareConfig,
  type ChatMiddlewareContext,
  type MetadataStore,
  type ModelMessage,
} from "@tanstack/ai";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Fiber,
  HashSet,
  Layer,
  MutableHashMap,
  Option,
  Result,
  Schema,
  Stream,
} from "effect";
import { expect, vi } from "vite-plus/test";
import type { ChatExecutionCapabilities } from "../../src/agent/chat-execution.ts";
import { compaction, lookupSources } from "../../src/agent/compaction.ts";
import { FullLoopOwnerRefusal, FullLoopOwnerRefused } from "../../src/agent/full-loop-execution.ts";
import { handoffNotice, modelHandoffHistory } from "../../src/agent/model-handoff.ts";
import { OwnerToolGrantRefused } from "../../src/agent/owner-tool-grants.ts";
import { Database } from "../../src/db/database.ts";
import { makePermissionGateMiddleware } from "../../src/permissions/gate.ts";
import { PermissionClassifier } from "../../src/permissions/classifier.ts";
import { PermissionReviews } from "../../src/permissions/reviews.ts";
import { nativeStream } from "../../src/runtime/native-stream.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { Subagents } from "../../src/subagents/subagents.ts";
import { ScriptedTextAdapter } from "../../src/testing/scripted-adapter.ts";
import { BackgroundTasks } from "../../src/tools/background.ts";
import { ToolFailed } from "../../src/tools/failure.ts";
import { toToolSchema } from "../../src/tools/schema.ts";
import { parallelReads } from "../../src/tools/parallel-reads.ts";
import { isTruthy } from "../../src/truthy.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import { inRun } from "../support/run-span.ts";
import {
  callerController,
  capabilities,
  collect,
  maliciousWorker,
  ownerFixture,
  ownerLayer,
  ownerTurn,
  sdkCall,
  sdkRunner,
  type OwnerFixture,
} from "./owner.ts";

const toJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** The tool result the model sees for one owner call. */
const toolMessage = (toolCallId: string, content: string) =>
  expect.objectContaining({
    role: "tool",
    toolCallId,
    content: expect.stringContaining(content),
  });

layer(ownerLayer, { excludeTestServices: true })("full-loop owner authority", (it) => {
  it.effect(
    "owner SDK services and UI-message normalization survive config/start/model boundaries",
    () =>
      Effect.gen(function* () {
        const f = yield* ownerFixture();
        const canonical = [{ id: "ui-user", role: "user", content: "hello" }];
        const prompts = ["lead", { content: "structured instruction" }];
        let state: ChatMiddlewareContext | undefined;
        let started = false;
        let modelCalls = 0;
        const configPhases: string[] = [];
        class NativeLikeAdapter extends ScriptedTextAdapter {
          override chatStream(options: Parameters<ScriptedTextAdapter["chatStream"]>[0]) {
            return nativeStream(
              Stream.suspend(() => {
                modelCalls++;
                expect(options.messages).toEqual(canonical);
                expect(options.systemPrompts).toEqual(prompts);
                expect(options.runId).toBe("r");
                expect(options.threadId).toBe("s");
                expect(options.capabilities).toBe(state);
                expect(options.logger.isEnabled("request")).toBe(false);
                options.logger.request("native adapter request");
                options.logger.provider("native adapter response");
                return Stream.fromAsyncIterable(
                  super.chatStream(options),
                  (cause) => new Cause.UnknownError(cause),
                );
              }),
            );
          }
        }
        const chunks = yield* collect(
          f.owner,
          capabilities(
            { adapter: new NativeLikeAdapter([{ text: "normalized answer" }]) },
            {
              middleware: [
                {
                  name: "canonical-lifecycle",
                  setup: (ctx) => {
                    state = ctx;
                  },
                  onConfig: (ctx, config) => {
                    configPhases.push(ctx.phase);
                    expect(ctx.runId).toBe("r");
                    expect(ctx.messages).toEqual(canonical);
                    expect(config.messages).toEqual(canonical);
                    expect(config.systemPrompts).toEqual(prompts);
                  },
                  onStart: (ctx) => {
                    expect(ctx).toBe(state);
                    expect(ctx.phase).toBe("init");
                    expect(ctx.messages).toEqual(canonical);
                    started = true;
                  },
                },
              ],
            },
          ),
          {
            ...ownerTurn,
            messages: [
              { id: "ui-user", role: "user", parts: [{ type: "text", content: "hello" }] },
            ],
            systemPrompts: prompts,
          },
        );
        expect(started).toBe(true);
        expect(modelCalls).toBe(1);
        expect(configPhases).toEqual(["init", "beforeModel"]);
        expect(chunks).toContainEqual(
          expect.objectContaining({ type: "TEXT_MESSAGE_CONTENT", delta: "normalized answer" }),
        );
      }),
    20000,
  );

  it.effect(
    "real worker SDK executes owner tool, second model iteration and durable middleware",
    () =>
      Effect.gen(function* () {
        const f = yield* ownerFixture();
        const adapter = new ScriptedTextAdapter([
          { toolCalls: [{ id: "c1", name: "owner_tool", arguments: "{}" }] },
          { text: "finished" },
        ]);
        let calls = 0;
        let finished = 0;
        const tool = toolDefinition({ name: "owner_tool", description: "owner" }).server(() => {
          calls++;
          return "persisted tool result";
        });
        const chunks = yield* collect(
          f.owner,
          capabilities(
            { adapter, agentLoopStrategy: maxIterations(3) },
            {
              tools: [tool],
              middleware: [
                {
                  name: "record",
                  onFinish: () => {
                    finished++;
                  },
                },
              ],
            },
          ),
          { ...ownerTurn, messages: [{ role: "user", content: "go" }] },
        );
        expect(calls).toBe(1);
        expect(finished).toBe(1);
        expect(adapter.invocations).toHaveLength(2);
        expect(adapter.invocations[1]?.messages.some((message) => message.role === "tool")).toBe(
          true,
        );
        expect(chunks.some((chunk) => chunk.type === "TOOL_CALL_RESULT")).toBe(true);
        expect(chunks).toContainEqual(
          expect.objectContaining({ type: "TEXT_MESSAGE_CONTENT", delta: "finished" }),
        );
        const rows = f.sqlite.prepare("SELECT fingerprint, status FROM owner_rpc_operations").all();
        expect(rows.some((row) => String(row.fingerprint).includes('"operation":"tool"'))).toBe(
          true,
        );
        expect(rows.every((row) => row.status === "succeeded")).toBe(true);
        const reopened = yield* f.reopenRead;
        expect(
          reopened.prepare("SELECT fingerprint, status FROM owner_rpc_operations").all(),
        ).toEqual(rows);
      }),
    20000,
  );

  it.effect(
    "arguments the stream cut off or the schema refuses go back to the model, not end the run",
    () =>
      Effect.gen(function* () {
        const f = yield* ownerFixture();
        const adapter = new ScriptedTextAdapter([
          {
            toolCalls: [
              { id: "cut", name: "owner_tool", arguments: '{"value": "unterminated' },
              { id: "invalid", name: "owner_tool", arguments: '{"not": "null"}' },
            ],
          },
          { text: "retried" },
        ]);
        let calls = 0;
        let phases = 0;
        const tool = toolDefinition({
          name: "owner_tool",
          description: "owner",
          inputSchema: toToolSchema(Schema.Struct({ value: Schema.String })),
        }).server(() => {
          calls++;
          return "unused";
        });
        const chunks = yield* collect(
          f.owner,
          capabilities(
            { adapter, agentLoopStrategy: maxIterations(3) },
            {
              tools: [tool],
              middleware: [
                {
                  name: "record",
                  onToolPhaseComplete: () => {
                    phases++;
                  },
                },
              ],
            },
          ),
          { ...ownerTurn, messages: [{ role: "user", content: "go" }] },
        );
        expect(calls).toBe(0);
        expect(phases).toBe(1);
        const answered = adapter.invocations[1]?.messages.filter((m) => m.role === "tool") ?? [];
        expect(answered.map((m) => [m.toolCallId, m.content])).toEqual([
          ["cut", expect.stringContaining("not valid JSON")],
          ["invalid", expect.stringContaining("Input validation failed for tool owner_tool")],
        ]);
        expect(chunks).toContainEqual(
          expect.objectContaining({ type: "TEXT_MESSAGE_CONTENT", delta: "retried" }),
        );
      }),
    20000,
  );

  it.effect(
    "a retrieval audit write followed by failure remains uncertain through the real worker",
    () =>
      Effect.gen(function* () {
        const f = yield* ownerFixture();
        f.sqlite.exec("CREATE TABLE retrieval_audit(id INTEGER PRIMARY KEY)");
        const adapter = new ScriptedTextAdapter([
          { toolCalls: [{ id: "audited-read", name: "find_memory", arguments: "{}" }] },
          { text: "must not convert a partial write into a settled read error" },
        ]);
        const tool = toolDefinition({
          name: "find_memory",
          description: "audited retrieval",
        }).server(() => {
          f.sqlite.exec("INSERT INTO retrieval_audit VALUES(1)");
          throw new Error("Failure after writing retrieval audit");
        });
        yield* Effect.result(
          collect(
            f.owner,
            capabilities({ adapter, agentLoopStrategy: maxIterations(3) }, { tools: [tool] }),
          ),
        );
        expect(f.sqlite.prepare("SELECT id FROM retrieval_audit").all()).toEqual([{ id: 1 }]);
        expect(f.toolStatuses()).toEqual([{ status: "uncertain" }]);
      }),
    20000,
  );

  it.effect.each([
    { probe: "config accessor", member: "config", key: "nested", enumerable: true },
    { probe: "hook accessor", member: "middleware", key: "onStart", enumerable: true },
    { probe: "symbol hook accessor", member: "middleware", key: Symbol("hook"), enumerable: true },
    { probe: "hidden hook accessor", member: "middleware", key: "onStart", enumerable: false },
  ] as const)(
    "run snapshot rejects an unsupported $probe without invoking it",
    ({ member, key, enumerable }) =>
      Effect.gen(function* () {
        const f = yield* ownerFixture();
        let getterCalls = 0;
        const adapter = new ScriptedTextAdapter([{ text: "must not run" }]);
        const modelCall = vi.spyOn(adapter, "chatStream");
        const context = {};
        const mw = { name: "accessor-probe" };
        Object.defineProperty(member === "config" ? context : mw, key, {
          enumerable,
          get: () => {
            getterCalls++;
            return () => undefined;
          },
        });
        const rejected = yield* Effect.flip(
          collect(f.owner, capabilities({ adapter }, { middleware: [mw] }), {
            ...ownerTurn,
            context,
          }),
        );
        expect(String(rejected.cause)).toContain("accessor");
        expect(getterCalls).toBe(0);
        expect(modelCall).not.toHaveBeenCalled();
        expect(f.operations()).toBe(0);
      }),
  );

  it.effect(
    "real SDK worker pins owner callables per execution without freezing their receivers",
    () =>
      Effect.gen(function* () {
        const first = yield* ownerFixture();
        const second = yield* ownerFixture();
        const gate = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined));
        const started = yield* Deferred.make<void>();
        const calls: string[] = [];
        let guardedTool: ChatMiddlewareConfig["tools"][number] | undefined;
        class GatedAdapter extends ScriptedTextAdapter {
          override chatStream(options: Parameters<ScriptedTextAdapter["chatStream"]>[0]) {
            return nativeStream(
              Stream.suspend(() => {
                expect(this).toBe(adapter);
                calls.push("old-model");
                const source = () =>
                  Stream.fromAsyncIterable(
                    super.chatStream(options),
                    (cause) => new Cause.UnknownError(cause),
                  );
                return this.invocations.length === 0
                  ? Stream.fromEffect(
                      Deferred.succeed(started, undefined).pipe(
                        Effect.andThen(Deferred.await(gate)),
                      ),
                    ).pipe(Stream.flatMap(source))
                  : source();
              }),
            );
          }
        }
        const adapter = new GatedAdapter([
          { toolCalls: [{ id: "c1", name: "owner_tool", arguments: "{}" }] },
          { text: "first finished" },
          { toolCalls: [{ id: "c2", name: "owner_tool", arguments: "{}" }] },
          { text: "second finished" },
        ]);
        const tool = toolDefinition({ name: "owner_tool", description: "original" }).server(() => {
          calls.push("old-tool");
          return "old";
        });
        const mw = {
          name: "record",
          onConfig(_ctx: ChatMiddlewareContext, config: ChatMiddlewareConfig) {
            expect(this).toBe(mw);
            guardedTool = config.tools[0];
            expect(guardedTool?.description).toBe("original");
          },
          onBeforeToolCall() {
            expect(this).toBe(mw);
            calls.push("old-permission");
          },
          onFinish() {
            expect(this).toBe(mw);
            calls.push("old-finish");
          },
        };
        const tools = [tool];
        const middleware = [mw];
        const run = {
          model: { adapter, agentLoopStrategy: maxIterations(3) },
          tools,
          middleware,
          stream: { abortController: callerController() },
        };
        const running = yield* Effect.forkChild(collect<GatedAdapter>(first.owner, run), {
          startImmediately: true,
        });
        yield* Deferred.await(started);
        // Every owner member changes while the first execution is suspended in its model call.
        expect(
          Reflect.set(
            adapter,
            "chatStream",
            function (this: GatedAdapter, options: Parameters<GatedAdapter["chatStream"]>[0]) {
              return nativeStream(
                Stream.suspend(() => {
                  expect(this).toBe(adapter);
                  calls.push("new-model");
                  return Stream.fromAsyncIterable(
                    ScriptedTextAdapter.prototype.chatStream.call(this, options),
                    (cause) => new Cause.UnknownError(cause),
                  );
                }),
              );
            },
          ),
        ).toBe(true);
        expect(
          Reflect.set(tool, "execute", () => {
            calls.push("new-tool");
            return "new";
          }),
        ).toBe(true);
        expect(Reflect.set(tool, "description", "changed")).toBe(true);
        expect(
          Reflect.set(mw, "onBeforeToolCall", function (this: typeof mw) {
            expect(this).toBe(mw);
            calls.push("new-permission");
          }),
        ).toBe(true);
        expect(
          Reflect.set(mw, "onFinish", function (this: typeof mw) {
            expect(this).toBe(mw);
            calls.push("new-finish");
          }),
        ).toBe(true);
        expect(
          Reflect.set(mw, "onConfig", function (this: typeof mw) {
            expect(this).toBe(mw);
          }),
        ).toBe(true);
        expect(Reflect.set(tools, 0, { ...tool })).toBe(true);
        expect(
          Reflect.set(middleware, 1, {
            name: "new-entry",
            onBeforeToolCall: () => {
              calls.push("new-entry-permission");
            },
          }),
        ).toBe(true);
        yield* Deferred.succeed(gate, undefined);
        expect(yield* Fiber.join(running)).toContainEqual(
          expect.objectContaining({ type: "TEXT_MESSAGE_CONTENT", delta: "first finished" }),
        );
        expect(calls).toEqual([
          "old-model",
          "old-permission",
          "old-tool",
          "old-model",
          "old-finish",
        ]);
        const inactive = yield* Effect.flip(
          Effect.asVoid(
            sdkCall(() =>
              guardedTool!.execute!(
                {},
                {
                  toolCallId: "c1",
                  abortSignal: run.stream.abortController.signal,
                  emitCustomEvent: () => undefined,
                },
              ),
            ),
          ),
        );
        expect(inactive.cause).toBeInstanceOf(FullLoopOwnerRefused);
        expect(inactive.cause).toMatchObject({
          reason: FullLoopOwnerRefusal.cases.Inactive.make({ stage: "tool" }),
        });
        expect(Reflect.set(run.stream, "abortController", callerController())).toBe(true);
        yield* collect<GatedAdapter>(second.owner, run);
        expect(calls.slice(5)).toEqual([
          "new-model",
          "new-permission",
          "new-entry-permission",
          "new-tool",
          "new-model",
          "new-finish",
        ]);
      }),
    20000,
  );

  it.effect.each([true, false])(
    "worker model handoff retains execution without replaying old calls (result: %s)",
    (hasOldResult) =>
      Effect.gen(function* () {
        const f = yield* ownerFixture();
        const values = MutableHashMap.empty<string, unknown>();
        const metadata: MetadataStore = {
          get: (namespace, key) =>
            Promise.resolve(
              Option.getOrUndefined(MutableHashMap.get(values, `${namespace}:${key}`)) ?? null,
            ),
          set: (namespace, key, value) => {
            MutableHashMap.set(values, `${namespace}:${key}`, value);
            return Promise.resolve();
          },
          delete: (namespace, key) => {
            MutableHashMap.remove(values, `${namespace}:${key}`);
            return Promise.resolve();
          },
        };
        const oldResult = { role: "tool" as const, toolCallId: "old", content: "old result" };
        const past = [
          { role: "user" as const, content: "build the project" },
          {
            role: "assistant" as const,
            content: null,
            metadata: { tanstack: { model: "old" } },
            toolCalls: [
              {
                id: "old",
                type: "function" as const,
                function: { name: "owner_tool", arguments: "{}" },
              },
            ],
          },
          ...(hasOldResult ? [oldResult] : []),
        ];
        const adapter = new ScriptedTextAdapter([
          { toolCalls: [{ id: "new", name: "owner_tool", arguments: "{}" }] },
          { text: "done" },
        ]);
        let executions = 0;
        let saved: readonly ModelMessage[] = [];
        yield* collect(
          f.owner,
          capabilities(
            { adapter, agentLoopStrategy: maxIterations(3) },
            {
              tools: [
                toolDefinition({ name: "owner_tool", description: "owner" }).server(() => {
                  executions++;
                  return "new result";
                }),
              ],
              middleware: [
                compaction(
                  metadata,
                  lookupSources({ toolResultId: () => null, nodeText: () => null }),
                  { compactAt: 0, leaveOutAt: 1_000_000 },
                  undefined,
                  modelHandoffHistory({
                    metadata,
                    threadId: "s",
                    target: "new",
                    model: "new",
                    provider: "openai",
                    loadHistory: () => Promise.resolve(past),
                    toolResultIds: () => Effect.succeed(new Map()),
                  }),
                ),
                {
                  name: "canonical",
                  onToolPhaseComplete: (_ctx, info) => {
                    for (const call of info.toolCalls) {
                      expect(call.function.name).toBe("owner_tool");
                      expect(info.results.some((result) => result.toolCallId === call.id)).toBe(
                        true,
                      );
                    }
                  },
                  onFinish: (ctx) => {
                    saved = [...ctx.messages];
                  },
                },
              ],
            },
          ),
          { ...ownerTurn, messages: [...past, { role: "user", content: "continue" }] },
        );
        expect(executions).toBe(1);
        const firstModelCall = adapter.invocations[0]?.messages ?? [];
        expect(
          firstModelCall.filter(
            (message) => message.role !== "tool" && !isTruthy(message.toolCalls?.length),
          ),
        ).toEqual([
          { role: "assistant", content: handoffNotice },
          past[0],
          ...(hasOldResult
            ? [
                {
                  role: "assistant",
                  content:
                    "[Earlier tool call owner_tool. Its output is kept in memory: find it with find_memory, then read it with read_evidence.]",
                },
              ]
            : []),
          { role: "user", content: "continue" },
        ]);
        if (hasOldResult) expect(saved).toContainEqual(oldResult);
        else
          expect(firstModelCall).toContainEqual(
            expect.objectContaining({
              role: "tool",
              toolCallId: "old",
              content: yield* toJson({ error: "Tool execution cancelled" }),
            }),
          );
        expect(adapter.invocations[1]?.messages).toContainEqual(
          expect.objectContaining({ role: "tool", toolCallId: "new", content: "new result" }),
        );
        expect(saved).toContainEqual(expect.objectContaining({ role: "tool", toolCallId: "new" }));
      }),
    20000,
  );

  it.effect(
    "a failed owner read reaches the worker's model as its code, tag and detail",
    () =>
      Effect.gen(function* () {
        const f = yield* ownerFixture();
        const failure = ToolFailed.make({
          code: "not_found",
          tag: "TextFileRejected",
          detail: "docs/a.md. Nothing exists at that path.",
        });
        const read = toolDefinition({ name: "read_file", description: "read" }).server(() =>
          Promise.reject(failure),
        );
        const chunks = yield* collect(
          f.owner,
          capabilities(
            {
              adapter: new ScriptedTextAdapter([
                { toolCalls: [{ id: "missing", name: "read_file", arguments: "{}" }] },
                { text: "done" },
              ]),
              agentLoopStrategy: maxIterations(3),
            },
            { tools: [read] },
          ),
        );
        expect(chunks).toContainEqual(
          expect.objectContaining({
            type: "TOOL_CALL_RESULT",
            toolCallId: "missing",
            content: yield* toJson({
              error: "not_found",
              cause: "TextFileRejected",
              detail: "docs/a.md. Nothing exists at that path.",
            }),
          }),
        );
      }),
    20000,
  );

  it.effect(
    "parallel reads use only owner observations and evaluate every permission before prefetch",
    () =>
      Effect.gen(function* () {
        const runSdk = yield* sdkRunner();
        const f = yield* ownerFixture();
        const controller = callerController();
        const permissions: string[] = [];
        const started: string[] = [];
        const gate = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined));
        const raw = ["read_file", "read_evidence", "list_files"].map((name) =>
          toolDefinition({ name, description: name }).server(() =>
            runSdk(
              Effect.gen(function* () {
                expect(permissions).toEqual(["one", "blocked", "three"]);
                started.push(name);
                if (started.length === 2) yield* Deferred.succeed(gate, undefined);
                yield* Deferred.await(gate);
                return name;
              }),
            ),
          ),
        );
        const parallel = parallelReads(raw, controller.signal);
        let legacyPrefetch = 0;
        let guardedBeforeModel = false;
        const legacyMiddleware = {
          ...parallel.middleware,
          onBeforeToolCall: (
            ...args: Parameters<NonNullable<typeof parallel.middleware.onBeforeToolCall>>
          ) => {
            legacyPrefetch++;
            return parallel.middleware.onBeforeToolCall!(...args);
          },
        };
        const adapter = new ScriptedTextAdapter([
          {
            toolCalls: [
              { id: "one", name: "read_file", arguments: "{}" },
              { id: "blocked", name: "read_evidence", arguments: "{}" },
              { id: "three", name: "list_files", arguments: "{}" },
            ],
          },
          { text: "done" },
        ]);
        let state: ChatMiddlewareContext | undefined;
        yield* collect(
          f.owner,
          capabilities(
            { adapter, agentLoopStrategy: maxIterations(3) },
            {
              tools: parallel.tools,
              middleware: [
                {
                  name: "permission",
                  onConfig: (_ctx, config) =>
                    runSdk(
                      Effect.gen(function* () {
                        if (guardedBeforeModel) return;
                        const tool = config.tools.find((tool) => tool.name === "read_file");
                        if (tool?.execute === undefined)
                          return yield* new Cause.UnknownError(new Error("Missing owner tool"));
                        const execute = tool.execute;
                        const ungranted = yield* Effect.flip(
                          Effect.asVoid(
                            sdkCall(() =>
                              execute(
                                {},
                                {
                                  toolCallId: "one",
                                  abortSignal: controller.signal,
                                  emitCustomEvent: () => undefined,
                                },
                              ),
                            ),
                          ),
                        ).pipe(Effect.orDie);
                        expect(ungranted.cause).toBeInstanceOf(OwnerToolGrantRefused);
                        expect(ungranted.cause).toMatchObject({
                          reason: "repeated_implementation_grant",
                        });
                        expect(started).toEqual([]);
                        guardedBeforeModel = true;
                      }),
                    ),
                  setup: (ctx) => {
                    state = ctx;
                  },
                  onBeforeToolCall: (ctx, info) => {
                    expect(ctx).toBe(state);
                    expect(
                      ctx.messages
                        .flatMap((message) =>
                          message.role === "assistant" ? (message.toolCalls ?? []) : [],
                        )
                        .map((call) => call.id),
                    ).toEqual(["one", "blocked", "three"]);
                    permissions.push(info.toolCallId);
                    return info.toolCallId === "blocked"
                      ? { type: "skip", result: "denied" }
                      : undefined;
                  },
                },
                legacyMiddleware,
              ],
              stream: { abortController: controller },
            },
          ),
        );
        expect(started).toEqual(["read_file", "list_files"]);
        expect(permissions).toEqual(["one", "blocked", "three"]);
        expect(legacyPrefetch).toBe(0);
        expect(guardedBeforeModel).toBe(true);
      }),
    20000,
  );
});

/** The permission gate's review log lives in the owner database of the run it gates. */
class Owner extends Context.Service<Owner, OwnerFixture>()(
  "memory-agent/tests/full-loop/owner-authority.test/Owner",
) {}
const ownerWithReviews = PermissionReviews.layer.pipe(
  Layer.provideMerge(Database.over(Effect.map(Owner, ({ sqlite }) => sqlite))),
  Layer.provideMerge(Layer.effect(Owner, ownerFixture())),
  Layer.provideMerge(ownerLayer),
);

layer(ownerWithReviews, { excludeTestServices: true })("full-loop owner RPC authority", (it) => {
  it.effect(
    "tampered worker RPC name/args/ID/context is rejected before durable reservation",
    () =>
      Effect.gen(function* () {
        const f = yield* Owner;
        const reviews = yield* PermissionReviews;
        let effects = 0;
        let permissions = 0;
        let cleanup = 0;
        let ownerTranscriptChecked = false;
        yield* reviews.record({
          sessionId: "s",
          toolCallId: "c",
          toolName: "owner_tool",
          input: '{"value":"safe"}',
          decision: "allow",
          decidedBy: "classifier",
          reason: "approved exact owner call",
        });
        const permission = yield* makePermissionGateMiddleware({
          sessionId: "s",
          gated: HashSet.fromIterable(["owner_tool", "other"]),
          decider: "classifier",
          project: {
            id: "p",
            root: "/tmp",
            name: "p",
            crossRecallExcluded: false,
            permissionMode: "auto",
            createdAt: "now",
            hiddenAt: null,
          },
          selection: { provider: "openai", model: "scripted-1", reasoningEffort: "none" },
        }).pipe(
          Effect.provideService(PermissionClassifier, {
            classify: () =>
              Promise.reject(
                new Error("Existing review must be reused only for the observed call"),
              ),
          }),
        );
        const workerUrl = maliciousWorker(`
      const opened = await rpc('modelOpen', { messages: [], tools: [], runId: 'r', threadId: 's' });
      const stream = decodeFullLoopValue(opened.output);
      while (true) {
        const reply = await rpc('modelNext', { id: stream.id });
        if (decodeFullLoopValue(reply.output).done) break;
      }
      const call = { name: 'owner_tool', toolCallId: 'c', args: { value: 'safe' } };
      const fakeMessages = [{ role: 'assistant', toolCalls: [{ id: 'forged', type: 'function',
        function: { name: 'other', arguments: '{}' } }] }];
      const transcript = await rpc('middleware', { index: 0, hook: 'onConfig',
        context: { runId: 'r', threadId: 's', provider: 'scripted', model: 'scripted-1',
          source: 'server', context: {}, messages: fakeMessages },
        info: { messages: fakeMessages, systemPrompts: ['worker forged prompt'], tools: [] } });
      const rejected = [];
      for (const attack of [
        { ...call, name: 'other' }, { ...call, toolCallId: 'fake' },
        { ...call, args: { value: 'unsafe' } }, { ...call, context: { approved: true } },
      ]) rejected.push((await rpc('toolAuthorize', attack)).type);
      const authorization = await rpc('toolAuthorize', call);
      for (const attack of [
        { ...call, name: 'other' }, { ...call, toolCallId: 'fake' },
        { ...call, args: { value: 'unsafe' } }, { ...call, context: { approved: true } },
      ]) rejected.push((await rpc('tool', attack)).type);
      rejected.push((await rpc('middleware', { index: 0, hook: 'onFinish', info: {},
        context: { runId: 'forged', threadId: 's', provider: 'scripted', model: 'scripted-1',
          source: 'server', context: {} } })).type);
      const legitimate = await rpc('tool', call);
      return { type: 'CUSTOM', name: 'results',
        value: { rejected, authorization: authorization.type, legitimate: legitimate.type, transcript: transcript.type } };
    `);
        const adapter = new ScriptedTextAdapter([
          { toolCalls: [{ id: "c", name: "owner_tool", arguments: '{"value":"safe"}' }] },
        ]);
        const tool = toolDefinition({ name: "owner_tool", description: "owner" }).server(() => {
          effects++;
          return "safe result";
        });
        const chunks = yield* collect(
          { ...f.owner, workerUrl },
          capabilities(
            { adapter },
            {
              tools: [tool],
              middleware: [
                {
                  name: "gate",
                  onConfig: (ctx, config) => {
                    const ownerCalls = ctx.messages.flatMap((message) =>
                      message.role === "assistant" ? (message.toolCalls ?? []) : [],
                    );
                    expect(ownerCalls.map((call) => call.id)).toEqual(["c"]);
                    expect(ownerCalls[0]?.function).toEqual({
                      name: "owner_tool",
                      arguments: '{"value":"safe"}',
                    });
                    expect(config.messages).toBe(ctx.messages);
                    expect(config.systemPrompts).toEqual([]);
                    ownerTranscriptChecked = true;
                  },
                  onBeforeToolCall: (ctx, info) => {
                    permissions++;
                    expect(ctx.runId).toBe("r");
                    expect(info.args).toEqual({ value: "safe" });
                    return permission.onBeforeToolCall?.(ctx, info);
                  },
                  onFinish: () => {
                    cleanup++;
                  },
                },
              ],
            },
          ),
        );
        expect(chunks).toMatchObject([
          {
            type: "CUSTOM",
            value: {
              rejected: Array(9).fill("rejected"),
              authorization: "succeeded",
              legitimate: "succeeded",
              transcript: "succeeded",
            },
          },
        ]);
        expect(effects).toBe(1);
        expect(permissions).toBe(1);
        expect(cleanup).toBe(0);
        expect(ownerTranscriptChecked).toBe(true);
        const rows = f.sqlite.prepare("SELECT status FROM owner_rpc_operations").all();
        expect(rows.every((row) => row.status === "succeeded")).toBe(true);
      }),
    20000,
  );
});

/** A session of its own in the shared agent. */
const freshSession = Effect.gen(function* () {
  const { project } = yield* TestEnv;
  return yield* (yield* Sessions).create(project.id);
});

/** One owner tool call, then a closing turn, through the real worker; the model's view of it. */
const callOnce = Effect.fnUntraced(function* (
  tools: ChatExecutionCapabilities<ScriptedTextAdapter>["tools"],
  call: { readonly id: string; readonly name: string; readonly input: Schema.Json },
  middleware: ChatExecutionCapabilities<ScriptedTextAdapter>["middleware"] = [],
) {
  const f = yield* ownerFixture();
  const adapter = new ScriptedTextAdapter([
    { toolCalls: [{ id: call.id, name: call.name, arguments: yield* toJson(call.input) }] },
    { text: "handled" },
  ]);
  const result = yield* Effect.result(
    collect(
      f.owner,
      capabilities({ adapter, agentLoopStrategy: maxIterations(3) }, { tools, middleware }),
    ),
  );
  return { result, toolStatuses: f.toolStatuses(), followUp: adapter.invocations[1]?.messages };
});

testAgent()("full-loop owner tool read/write semantics", (it) => {
  it.effect.each(["get_background_result", "cancel_background_task"] as const)(
    "missing background task through the real worker preserves read/write failure semantics (%s)",
    (name) =>
      Effect.gen(function* () {
        const session = yield* freshSession;
        const tool = (yield* inRun((yield* BackgroundTasks).forSession(session.id))).find(
          (tool) => tool.name === name,
        )!;
        const { result, toolStatuses, followUp } = yield* callOnce([tool], {
          id: "missing",
          name,
          input: { taskId: "missing-task" },
        });
        switch (name) {
          case "get_background_result":
            expect(Result.isSuccess(result)).toBe(true);
            expect(followUp).toContainEqual(
              toolMessage("missing", "Background task not found in this session"),
            );
            expect(toolStatuses).toEqual([{ status: "succeeded" }]);
            break;
          case "cancel_background_task":
            // The SDK can finish after an RPC rejection, but durable Goal execution
            // must still see the unresolved write and refuse completion.
            expect(toolStatuses).toEqual([{ status: "uncertain" }]);
            break;
        }
      }),
    20000,
  );

  it.effect.each(["get_subagent_report", "get_subagent_reports", "wait_subagents"] as const)(
    "missing subagent reports through the real worker return a settled read failure (%s)",
    (name) =>
      Effect.gen(function* () {
        const { project } = yield* TestEnv;
        const session = yield* freshSession;
        const controller = callerController();
        const run = (yield* Subagents).forRun({
          project,
          sessionId: session.id,
          runId: `${session.id}:r`,
          selection: { provider: "openai", model: "scripted-1", reasoningEffort: "none" },
          abortSignal: controller.signal,
          tools: [],
          systemPrompts: [],
          deliveredParentNotificationIds: HashSet.empty(),
          gated: HashSet.empty(),
        });
        const tool = run.tools.find((candidate) => candidate.name === name)!;
        const attempts = [
          {
            taskId: "5254f3ea-8610-405d-9d75-83644aa455fc",
            attemptId: "19c53746-50de-43d9-a8b3-9a9ff13c8a4a",
          },
          {
            taskId: "21419ef4-480f-4a5b-8bed-3993bc595887",
            attemptId: "91083f5c-96fd-447e-b00e-4a2656669762",
          },
          {
            taskId: "c7853ba4-887d-4f6f-8a68-d31867c428b0",
            attemptId: "61f3d383-537b-4d5e-ab11-82fb7a468282",
          },
        ];
        let input: Schema.Json;
        let failingModule: string;
        switch (name) {
          case "get_subagent_report":
            input = attempts[0]!;
            failingModule = "subagents.ts";
            break;
          case "get_subagent_reports":
            input = { attempts };
            failingModule = "subagents.ts";
            break;
          case "wait_subagents":
            input = { attempts, mode: "all", timeoutMs: 0 };
            failingModule = "store.ts";
            break;
        }
        const rejection = yield* Effect.flip(Effect.asVoid(sdkCall(() => tool.execute!(input))));
        expect(rejection.cause).toBeInstanceOf(Error);
        if (rejection.cause instanceof Error) {
          expect(rejection.cause.message).toBe("Subagent attempt not found in this session");
          expect(rejection.cause.stack).toContain(failingModule);
        }
        const observed: boolean[] = [];
        const { result, toolStatuses, followUp } = yield* callOnce(
          [tool],
          { id: "missing-report", name, input },
          [
            {
              name: "read-outcome",
              onAfterToolCall: (_ctx, info) => {
                observed.push(info.ok);
              },
            },
          ],
        );
        expect(Result.isSuccess(result)).toBe(true);
        expect(followUp).toContainEqual(
          toolMessage("missing-report", "Subagent attempt not found in this session"),
        );
        expect(observed).toEqual([false]);
        expect(toolStatuses).toEqual([{ status: "succeeded" }]);
      }),
    20000,
  );
});
