import { chat, toolDefinition } from "@tanstack/ai";
import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { PermissionClassifier } from "../src/permissions/classifier.ts";
import { PermissionGate, type GateBinding } from "../src/permissions/gate.ts";
import { PermissionReviews } from "../src/permissions/reviews.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { ScriptedTextAdapter } from "../src/testing/scripted-adapter.ts";
import { permissionReviewInterrupt } from "../src/tools/definitions.ts";
import { testRuntime } from "./support/runtime.ts";

test("a retained permission factory uses each run's central Context and fresh session binding", async () => {
  const { runtime, project, session } = await testRuntime({ testProvider: {} });
  const nextSession = await runtime.runPromise(
    Effect.flatMap(Sessions, (sessions) => sessions.create(project.id)),
  );
  const factory = await runtime.runPromise(Effect.map(PermissionGate, (gate) => gate.factory));
  const reviews = await runtime.runPromise(PermissionReviews);
  const binding = (sessionId: string): GateBinding => ({
    project,
    sessionId,
    selection: { provider: "openai", model: "scripted-1", reasoningEffort: "none" },
    gated: new Set(["owner_tool"]),
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
  const allowed = await runtime.runPromise(
    factory(binding(session.id)).pipe(
      Effect.provideService(PermissionClassifier, {
        classify: async (request) => {
          classified.push(`old:${request.sessionId}`);
          return { decision: "allow", decidedBy: "classifier", reason: "old run allowed" };
        },
      }),
    ),
  );
  const blocked = await runtime.runPromise(
    factory(binding(nextSession.id)).pipe(
      Effect.provideService(PermissionClassifier, {
        classify: async (request) => {
          classified.push(`current:${request.sessionId}`);
          return { decision: "block", decidedBy: "classifier", reason: "current run blocked" };
        },
      }),
    ),
  );
  expect(allowed).not.toBe(blocked);
  const model = () =>
    new ScriptedTextAdapter([
      { toolCalls: [{ id: "same-call-id", name: "owner_tool", arguments: "{}" }] },
      { text: "finished" },
    ]);
  await chat({
    adapter: model(),
    messages: [],
    tools: [tool],
    interrupts: [permissionReviewInterrupt],
    middleware: [allowed],
    stream: false,
  });
  expect(calls).toEqual(["executed"]);
  expect(reviews.latest(session.id, "same-call-id")).toMatchObject({ decision: "allow" });
  expect(reviews.latest(nextSession.id, "same-call-id")).toBeNull();

  await chat({
    adapter: model(),
    messages: [],
    tools: [tool],
    interrupts: [permissionReviewInterrupt],
    middleware: [blocked],
    stream: false,
  });
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
});

test("reusing a tool-call ID with changed arguments cannot borrow a previous allow", async () => {
  const { runtime, project, session } = await testRuntime({ testProvider: {} });
  const factory = await runtime.runPromise(Effect.map(PermissionGate, (gate) => gate.factory));
  const reviews = await runtime.runPromise(PermissionReviews);
  const classified: string[] = [];
  let calls = 0;
  const tools = [
    toolDefinition({ name: "owner_tool", description: "approval identity" }).server(() => {
      calls++;
      return "executed";
    }),
  ];
  const run = async (argumentsJson: string) => {
    const middleware = await runtime.runPromise(
      factory({
        project,
        sessionId: session.id,
        selection: { provider: "openai", model: "scripted-1", reasoningEffort: "none" },
        gated: new Set(["owner_tool"]),
        decider: "classifier",
      }).pipe(
        Effect.provideService(PermissionClassifier, {
          classify: async (request) => {
            classified.push(request.argumentsJson);
            return {
              decision: request.argumentsJson.includes("dangerous") ? "block" : "allow",
              decidedBy: "classifier",
              reason: "fixture exact input decision",
            };
          },
        }),
      ),
    );
    await chat({
      adapter: new ScriptedTextAdapter([
        { toolCalls: [{ id: "repeat-id", name: "owner_tool", arguments: argumentsJson }] },
        { text: "finished" },
      ]),
      messages: [],
      tools,
      middleware: [middleware],
      interrupts: [permissionReviewInterrupt],
      stream: false,
    });
  };
  await run('{"action":"read"}');
  expect(calls).toBe(1);
  await run('{"action":"dangerous"}');
  expect(classified).toEqual(['{"action":"read"}', '{"action":"dangerous"}']);
  expect(calls).toBe(1);
  expect(reviews.latest(session.id, "repeat-id")).toMatchObject({
    input: '{"action":"dangerous"}',
    decision: "block",
  });
});

test("ask-every-call cannot apply a previous approval to a different tool", async () => {
  const { runtime, project, session } = await testRuntime();
  const reviews = await runtime.runPromise(PermissionReviews);
  const original = reviews.record({
    sessionId: session.id,
    toolCallId: "reused-id",
    toolName: "old_tool",
    input: "{}",
    decision: "approved",
    decidedBy: "user",
    reason: "fixture original tool approval",
  });
  const gate = await runtime.runPromise(
    Effect.flatMap(PermissionGate, (service) =>
      service.factory({
        project,
        sessionId: session.id,
        selection: { provider: "openai", model: "scripted-1", reasoningEffort: "none" },
        gated: new Set(["new_tool"]),
        decider: "user",
      }),
    ),
  );
  let calls = 0;
  const tool = toolDefinition({
    name: "new_tool",
    description: "different authorized action",
  }).server(() => {
    calls++;
    return "must not execute";
  });
  await chat({
    adapter: new ScriptedTextAdapter([
      { toolCalls: [{ id: "reused-id", name: "new_tool", arguments: "{}" }] },
      { text: "finished" },
    ]),
    messages: [],
    tools: [tool],
    interrupts: [permissionReviewInterrupt],
    middleware: [gate],
    stream: false,
  });
  expect(calls).toBe(0);
  expect(reviews.latest(session.id, "reused-id")).toEqual(original);
});

test("ask-every-call preserves exact approvals but denies changed input without rewriting evidence", async () => {
  const { runtime, project, session } = await testRuntime();
  const reviews = await runtime.runPromise(PermissionReviews);
  const original = reviews.record({
    sessionId: session.id,
    toolCallId: "approved-id",
    toolName: "owner_tool",
    input: '{"action":"read"}',
    decision: "approved",
    decidedBy: "user",
    reason: "fixture exact approved action",
  });
  const factory = await runtime.runPromise(Effect.map(PermissionGate, (gate) => gate.factory));
  let calls = 0;
  const tool = toolDefinition({ name: "owner_tool", description: "exact approval" }).server(() => {
    calls++;
    return "approved action executed";
  });
  const run = async (argumentsJson: string) => {
    const gate = await runtime.runPromise(
      factory({
        project,
        sessionId: session.id,
        selection: { provider: "openai", model: "scripted-1", reasoningEffort: "none" },
        gated: new Set(["owner_tool"]),
        decider: "user",
      }),
    );
    await chat({
      adapter: new ScriptedTextAdapter([
        { toolCalls: [{ id: "approved-id", name: "owner_tool", arguments: argumentsJson }] },
        { text: "finished" },
      ]),
      messages: [],
      tools: [tool],
      interrupts: [permissionReviewInterrupt],
      middleware: [gate],
      stream: false,
    });
  };
  await run(original.input);
  expect(calls).toBe(1);
  expect(reviews.latest(session.id, "approved-id")).toEqual(original);
  await run('{"action":"write"}');
  expect(calls).toBe(1);
  expect(reviews.latest(session.id, "approved-id")).toEqual(original);
});
