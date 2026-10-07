import { it } from "@effect/vitest";
import { sdkPromise } from "../src/runtime/sdk-promise.ts";
import { HashSet } from "effect";
import { chat, toolDefinition } from "@tanstack/ai";
import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { PermissionClassifier } from "../src/permissions/classifier.ts";
import { PermissionGate, type GateBinding } from "../src/permissions/gate.ts";
import { PermissionReviews } from "../src/permissions/reviews.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { ScriptedTextAdapter } from "../src/testing/scripted-adapter.ts";
import { permissionReviewInterrupt } from "../src/tools/definitions.ts";
import { testRuntime } from "./support/runtime.ts";

it.live(
  "a retained permission factory uses each run's central Context and fresh session binding",
  () =>
    Effect.gen(function* () {
      const { runtime, project, session } = yield* Effect.promise(() =>
        testRuntime({ testProvider: {} }),
      );
      const nextSession = yield* Effect.provideContext(
        Effect.flatMap(Sessions, (sessions) => sessions.create(project.id)),
        yield* runtime.contextEffect,
      );
      const factory = yield* Effect.provideContext(
        Effect.map(PermissionGate, (gate) => gate.factory),
        yield* runtime.contextEffect,
      );
      const reviews = yield* Effect.provideContext(PermissionReviews, yield* runtime.contextEffect);
      const binding = (sessionId: string): GateBinding => ({
        project,
        sessionId,
        selection: { provider: "openai", model: "scripted-1", reasoningEffort: "none" },
        gated: HashSet.fromIterable(["owner_tool"]),
        decider: "classifier",
      });
      const calls: string[] = [];
      const tool = toolDefinition({ name: "owner_tool", description: "factory regression" }).server(
        () => {
          calls.push("executed");
          return "allowed result";
        },
      );
      const classified: string[] = [];
      const allowed = yield* Effect.provideContext(
        factory(binding(session.id)).pipe(
          Effect.provideService(PermissionClassifier, {
            classify: (request) => {
              classified.push(`old:${request.sessionId}`);
              return Promise.resolve({
                decision: "allow",
                decidedBy: "classifier",
                reason: "old run allowed",
              });
            },
          }),
        ),
        yield* runtime.contextEffect,
      );
      const blocked = yield* Effect.provideContext(
        factory(binding(nextSession.id)).pipe(
          Effect.provideService(PermissionClassifier, {
            classify: (request) => {
              classified.push(`current:${request.sessionId}`);
              return Promise.resolve({
                decision: "block",
                decidedBy: "classifier",
                reason: "current run blocked",
              });
            },
          }),
        ),
        yield* runtime.contextEffect,
      );
      expect(allowed).not.toBe(blocked);
      const model = () =>
        new ScriptedTextAdapter([
          { toolCalls: [{ id: "same-call-id", name: "owner_tool", arguments: "{}" }] },
          { text: "finished" },
        ]);
      yield* sdkPromise((abortController) =>
        chat({
          adapter: model(),
          messages: [],
          tools: [tool],
          interrupts: [permissionReviewInterrupt],
          middleware: [allowed],
          stream: false,
          abortController,
        }),
      );
      expect(calls).toEqual(["executed"]);
      expect(reviews.latest(session.id, "same-call-id")).toMatchObject({ decision: "allow" });
      expect(reviews.latest(nextSession.id, "same-call-id")).toBeNull();

      yield* sdkPromise((abortController) =>
        chat({
          adapter: model(),
          messages: [],
          tools: [tool],
          interrupts: [permissionReviewInterrupt],
          middleware: [blocked],
          stream: false,
          abortController,
        }),
      );
      expect(calls).toEqual(["executed"]);
      expect(classified).toEqual([`old:${session.id}`, `current:${nextSession.id}`]);
      expect(reviews.latest(nextSession.id, "same-call-id")).toMatchObject({
        decision: "block",
        reason: "current run blocked",
      });
      expect(reviews.latest(session.id, "same-call-id")).toMatchObject({
        decision: "allow",
        reason: "old run allowed",
      });
    }),
);

it.live("reusing a tool-call ID with changed arguments cannot borrow a previous allow", () =>
  Effect.gen(function* () {
    const { runtime, project, session } = yield* Effect.promise(() =>
      testRuntime({ testProvider: {} }),
    );
    const factory = yield* Effect.provideContext(
      Effect.map(PermissionGate, (gate) => gate.factory),
      yield* runtime.contextEffect,
    );
    const reviews = yield* Effect.provideContext(PermissionReviews, yield* runtime.contextEffect);
    const classified: string[] = [];
    let calls = 0;
    const tools = [
      toolDefinition({ name: "owner_tool", description: "approval identity" }).server(() => {
        calls++;
        return "executed";
      }),
    ];
    const run = (argumentsJson: string) =>
      Effect.gen(function* () {
        const middleware = yield* Effect.provideContext(
          factory({
            project,
            sessionId: session.id,
            selection: { provider: "openai", model: "scripted-1", reasoningEffort: "none" },
            gated: HashSet.fromIterable(["owner_tool"]),
            decider: "classifier",
          }).pipe(
            Effect.provideService(PermissionClassifier, {
              classify: (request) => {
                classified.push(request.argumentsJson);
                return Promise.resolve({
                  decision: request.argumentsJson.includes("dangerous") ? "block" : "allow",
                  decidedBy: "classifier",
                  reason: "fixture exact input decision",
                });
              },
            }),
          ),
          yield* runtime.contextEffect,
        );
        yield* sdkPromise((abortController) =>
          chat({
            adapter: new ScriptedTextAdapter([
              { toolCalls: [{ id: "repeat-id", name: "owner_tool", arguments: argumentsJson }] },
              { text: "finished" },
            ]),
            messages: [],
            tools,
            middleware: [middleware],
            interrupts: [permissionReviewInterrupt],
            stream: false,
            abortController,
          }),
        );
      });
    yield* run('{"action":"read"}');
    expect(calls).toBe(1);
    yield* run('{"action":"dangerous"}');
    expect(classified).toEqual(['{"action":"read"}', '{"action":"dangerous"}']);
    expect(calls).toBe(1);
    expect(reviews.latest(session.id, "repeat-id")).toMatchObject({
      input: '{"action":"dangerous"}',
      decision: "block",
    });
  }),
);

it.live("ask-every-call cannot apply a previous approval to a different tool", () =>
  Effect.gen(function* () {
    const { runtime, project, session } = yield* Effect.promise(() => testRuntime());
    const reviews = yield* Effect.provideContext(PermissionReviews, yield* runtime.contextEffect);
    const original = reviews.record({
      sessionId: session.id,
      toolCallId: "reused-id",
      toolName: "old_tool",
      input: "{}",
      decision: "approved",
      decidedBy: "user",
      reason: "fixture original tool approval",
    });
    const gate = yield* Effect.provideContext(
      Effect.flatMap(PermissionGate, (service) =>
        service.factory({
          project,
          sessionId: session.id,
          selection: { provider: "openai", model: "scripted-1", reasoningEffort: "none" },
          gated: HashSet.fromIterable(["new_tool"]),
          decider: "user",
        }),
      ),
      yield* runtime.contextEffect,
    );
    let calls = 0;
    const tool = toolDefinition({
      name: "new_tool",
      description: "different authorized action",
    }).server(() => {
      calls++;
      return "must not execute";
    });
    yield* sdkPromise((abortController) =>
      chat({
        adapter: new ScriptedTextAdapter([
          { toolCalls: [{ id: "reused-id", name: "new_tool", arguments: "{}" }] },
          { text: "finished" },
        ]),
        messages: [],
        tools: [tool],
        interrupts: [permissionReviewInterrupt],
        middleware: [gate],
        stream: false,
        abortController,
      }),
    );
    expect(calls).toBe(0);
    expect(reviews.latest(session.id, "reused-id")).toEqual(original);
  }),
);

it.live(
  "ask-every-call preserves exact approvals but denies changed input without rewriting evidence",
  () =>
    Effect.gen(function* () {
      const { runtime, project, session } = yield* Effect.promise(() => testRuntime());
      const reviews = yield* Effect.provideContext(PermissionReviews, yield* runtime.contextEffect);
      const original = reviews.record({
        sessionId: session.id,
        toolCallId: "approved-id",
        toolName: "owner_tool",
        input: '{"action":"read"}',
        decision: "approved",
        decidedBy: "user",
        reason: "fixture exact approved action",
      });
      const factory = yield* Effect.provideContext(
        Effect.map(PermissionGate, (gate) => gate.factory),
        yield* runtime.contextEffect,
      );
      let calls = 0;
      const tool = toolDefinition({ name: "owner_tool", description: "exact approval" }).server(
        () => {
          calls++;
          return "approved action executed";
        },
      );
      const run = (argumentsJson: string) =>
        Effect.gen(function* () {
          const gate = yield* Effect.provideContext(
            factory({
              project,
              sessionId: session.id,
              selection: { provider: "openai", model: "scripted-1", reasoningEffort: "none" },
              gated: HashSet.fromIterable(["owner_tool"]),
              decider: "user",
            }),
            yield* runtime.contextEffect,
          );
          yield* sdkPromise((abortController) =>
            chat({
              adapter: new ScriptedTextAdapter([
                {
                  toolCalls: [{ id: "approved-id", name: "owner_tool", arguments: argumentsJson }],
                },
                { text: "finished" },
              ]),
              messages: [],
              tools: [tool],
              interrupts: [permissionReviewInterrupt],
              middleware: [gate],
              stream: false,
              abortController,
            }),
          );
        });
      yield* run(original.input);
      expect(calls).toBe(1);
      expect(reviews.latest(session.id, "approved-id")).toEqual(original);
      yield* run('{"action":"write"}');
      expect(calls).toBe(1);
      expect(reviews.latest(session.id, "approved-id")).toEqual(original);
    }),
);
