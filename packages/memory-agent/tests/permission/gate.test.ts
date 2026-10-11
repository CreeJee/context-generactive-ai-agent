import { chat, toolDefinition } from "@tanstack/ai";
import { Effect, HashSet } from "effect";
import { expect } from "vite-plus/test";
import { PermissionClassifier } from "../../src/permissions/classifier.ts";
import { PermissionGate, type GateBinding } from "../../src/permissions/gate.ts";
import { PermissionReviews } from "../../src/permissions/reviews.ts";
import { sdkPromise } from "../../src/runtime/sdk-promise.ts";
import { ScriptedTextAdapter } from "../../src/testing/scripted-adapter.ts";
import { permissionReviewInterrupt } from "../../src/tools/definitions.ts";
import { TestEnv, freshSession, testAgent } from "../support/test-env.ts";

/** Who decides a gated call: the classifier in `auto` mode, the user in `ask` mode. */
const binding = Effect.fnUntraced(function* (
  sessionId: string,
  tool: string,
  decider: GateBinding["decider"],
) {
  const { project } = yield* TestEnv;
  return {
    project,
    sessionId,
    selection: { provider: "openai", model: "scripted-1", reasoningEffort: "none" },
    gated: HashSet.fromIterable([tool]),
    decider,
  } satisfies GateBinding;
});

/** A classifier that records what it saw and decides by the call's arguments. */
const classifier = (
  seen: string[],
  decide: (request: { readonly sessionId: string; readonly argumentsJson: string }) => {
    readonly decision: "allow" | "block";
    readonly reason: string;
  },
): PermissionClassifier["Service"] => ({
  classify: (request) => {
    seen.push(`${request.sessionId}:${request.argumentsJson}`);
    return Promise.resolve({ ...decide(request), decidedBy: "classifier" });
  },
});

/** A tool that counts how often it really ran. */
const countedTool = (name: string) => {
  const runs = { count: 0 };
  const tool = toolDefinition({ name, description: "permission gate fixture" }).server(() => {
    runs.count += 1;
    return "executed";
  });
  return { tool, runs };
};

type Gate = Effect.Success<ReturnType<PermissionGate["Service"]["factory"]>>;

/** One model turn that calls `tool` with `id` and `argumentsJson`, through the gate. */
const gatedRun = (
  gate: Gate,
  tool: ReturnType<typeof countedTool>["tool"],
  id: string,
  argumentsJson: string,
) =>
  sdkPromise((abortController) =>
    chat({
      adapter: new ScriptedTextAdapter([
        { toolCalls: [{ id, name: tool.name, arguments: argumentsJson }] },
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

testAgent()("permission gate", (it) => {
  it.effect(
    "a retained permission factory uses each run's central Context and fresh session binding",
    () =>
      Effect.gen(function* () {
        const session = yield* freshSession;
        const nextSession = yield* freshSession;
        const { factory } = yield* PermissionGate;
        const reviews = yield* PermissionReviews;
        const { tool, runs } = countedTool("owner_tool");
        const classified: string[] = [];
        const allowed = yield* factory(yield* binding(session, "owner_tool", "classifier")).pipe(
          Effect.provideService(
            PermissionClassifier,
            classifier(classified, () => ({ decision: "allow", reason: "old run allowed" })),
          ),
        );
        const blocked = yield* factory(
          yield* binding(nextSession, "owner_tool", "classifier"),
        ).pipe(
          Effect.provideService(
            PermissionClassifier,
            classifier(classified, () => ({ decision: "block", reason: "current run blocked" })),
          ),
        );
        expect(allowed).not.toBe(blocked);

        yield* gatedRun(allowed, tool, "same-call-id", "{}");
        expect(runs.count).toBe(1);
        expect(reviews.latest(session, "same-call-id")).toMatchObject({ decision: "allow" });
        expect(reviews.latest(nextSession, "same-call-id")).toBeNull();

        yield* gatedRun(blocked, tool, "same-call-id", "{}");
        expect(runs.count).toBe(1);
        expect(classified).toEqual([`${session}:{}`, `${nextSession}:{}`]);
        expect(reviews.latest(nextSession, "same-call-id")).toMatchObject({
          decision: "block",
          reason: "current run blocked",
        });
        expect(reviews.latest(session, "same-call-id")).toMatchObject({
          decision: "allow",
          reason: "old run allowed",
        });
      }),
  );

  it.effect("reusing a tool-call ID with changed arguments cannot borrow a previous allow", () =>
    Effect.gen(function* () {
      const session = yield* freshSession;
      const { factory } = yield* PermissionGate;
      const reviews = yield* PermissionReviews;
      const { tool, runs } = countedTool("owner_tool");
      const classified: string[] = [];
      const run = Effect.fnUntraced(function* (argumentsJson: string) {
        const gate = yield* factory(yield* binding(session, "owner_tool", "classifier")).pipe(
          Effect.provideService(
            PermissionClassifier,
            classifier(classified, (request) => ({
              decision: request.argumentsJson.includes("dangerous") ? "block" : "allow",
              reason: "fixture exact input decision",
            })),
          ),
        );
        yield* gatedRun(gate, tool, "repeat-id", argumentsJson);
      });
      yield* run('{"action":"read"}');
      expect(runs.count).toBe(1);
      yield* run('{"action":"dangerous"}');
      expect(classified).toEqual([
        `${session}:{"action":"read"}`,
        `${session}:{"action":"dangerous"}`,
      ]);
      expect(runs.count).toBe(1);
      expect(reviews.latest(session, "repeat-id")).toMatchObject({
        input: '{"action":"dangerous"}',
        decision: "block",
      });
    }),
  );

  it.effect("ask-every-call cannot apply a previous approval to a different tool", () =>
    Effect.gen(function* () {
      const session = yield* freshSession;
      const reviews = yield* PermissionReviews;
      const original = reviews.record({
        sessionId: session,
        toolCallId: "reused-id",
        toolName: "old_tool",
        input: "{}",
        decision: "approved",
        decidedBy: "user",
        reason: "fixture original tool approval",
      });
      const gate = yield* (yield* PermissionGate).factory(
        yield* binding(session, "new_tool", "user"),
      );
      const { tool, runs } = countedTool("new_tool");
      yield* gatedRun(gate, tool, "reused-id", "{}");
      expect(runs.count).toBe(0);
      expect(reviews.latest(session, "reused-id")).toEqual(original);
    }),
  );

  it.effect(
    "ask-every-call preserves exact approvals but denies changed input without rewriting evidence",
    () =>
      Effect.gen(function* () {
        const session = yield* freshSession;
        const reviews = yield* PermissionReviews;
        const original = reviews.record({
          sessionId: session,
          toolCallId: "approved-id",
          toolName: "owner_tool",
          input: '{"action":"read"}',
          decision: "approved",
          decidedBy: "user",
          reason: "fixture exact approved action",
        });
        const { factory } = yield* PermissionGate;
        const { tool, runs } = countedTool("owner_tool");
        const run = Effect.fnUntraced(function* (argumentsJson: string) {
          const gate = yield* factory(yield* binding(session, "owner_tool", "user"));
          yield* gatedRun(gate, tool, "approved-id", argumentsJson);
        });
        yield* run(original.input);
        expect(runs.count).toBe(1);
        expect(reviews.latest(session, "approved-id")).toEqual(original);
        yield* run('{"action":"write"}');
        expect(runs.count).toBe(1);
        expect(reviews.latest(session, "approved-id")).toEqual(original);
      }),
  );
});
