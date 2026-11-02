import { Crypto, Effect, HashSet, Ref, Schema } from "effect";
import { expect } from "vite-plus/test";
import type { RunHook } from "../../src/loop/run.ts";
import { PermissionClassifier } from "../../src/permissions/classifier.ts";
import { makePermissionGateHook, type GateBinding } from "../../src/permissions/gate.ts";
import { PermissionReviews } from "../../src/permissions/reviews.ts";
import { runTool, type RunTool } from "../../src/tools/run-tool.ts";
import { scriptedRun } from "../support/loop-run.ts";
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
    readonly decision: "allow" | "ask" | "block";
    readonly reason: string;
  },
): PermissionClassifier["Service"] => ({
  classify: (request) => {
    seen.push(`${request.sessionId}:${request.argumentsJson}`);
    return Effect.succeed({ ...decide(request), decidedBy: "classifier" as const });
  },
});

/** A tool that counts how often it really ran. */
const countedTool = Effect.fnUntraced(function* (name: string) {
  const runs = yield* Ref.make(0);
  const tool = runTool({
    name,
    description: "permission gate fixture",
    parameters: Schema.Struct({}),
    handler: () =>
      Effect.as(
        Ref.update(runs, (count) => count + 1),
        "executed",
      ),
  });
  return { tool, runs: Ref.get(runs) };
});

/** One model turn that calls `tool` with `id` and `argumentsJson`, through the gate. */
const gatedRun = Effect.fnUntraced(function* (
  gate: RunHook<Crypto.Crypto>,
  tool: RunTool,
  id: string,
  argumentsJson: string,
) {
  const runId = yield* Effect.flatMap(Crypto.Crypto, (crypto) => crypto.randomUUIDv7());
  yield* scriptedRun({
    turns: [
      { toolCalls: [{ id, name: tool.tool.name, arguments: argumentsJson }] },
      { text: "finished" },
    ],
    runId,
    conversation: [{ role: "user", content: "go" }],
    tools: [tool],
    hooks: [gate],
  });
});

testAgent()("permission gate", (it) => {
  it.effect("each run's gate uses its own classifier and session binding", () =>
    Effect.gen(function* () {
      const session = yield* freshSession;
      const nextSession = yield* freshSession;
      const reviews = yield* PermissionReviews;
      const { tool, runs } = yield* countedTool("owner_tool");
      const classified: string[] = [];
      const allowed = yield* makePermissionGateHook(
        yield* binding(session, "owner_tool", "classifier"),
      ).pipe(
        Effect.provideService(
          PermissionClassifier,
          classifier(classified, () => ({ decision: "allow", reason: "old run allowed" })),
        ),
      );
      const blocked = yield* makePermissionGateHook(
        yield* binding(nextSession, "owner_tool", "classifier"),
      ).pipe(
        Effect.provideService(
          PermissionClassifier,
          classifier(classified, () => ({ decision: "block", reason: "current run blocked" })),
        ),
      );

      yield* gatedRun(allowed, tool, "same-call-id", "{}");
      expect(yield* runs).toBe(1);
      expect(yield* reviews.latest(session, "same-call-id")).toMatchObject({ decision: "allow" });
      expect(yield* reviews.latest(nextSession, "same-call-id")).toBeNull();

      yield* gatedRun(blocked, tool, "same-call-id", "{}");
      expect(yield* runs).toBe(1);
      expect(classified).toEqual([`${session}:{}`, `${nextSession}:{}`]);
      expect(yield* reviews.latest(nextSession, "same-call-id")).toMatchObject({
        decision: "block",
        reason: "current run blocked",
      });
      expect(yield* reviews.latest(session, "same-call-id")).toMatchObject({
        decision: "allow",
        reason: "old run allowed",
      });
    }),
  );

  it.effect("reusing a tool-call ID with changed arguments cannot borrow a previous allow", () =>
    Effect.gen(function* () {
      const session = yield* freshSession;
      const reviews = yield* PermissionReviews;
      const { tool, runs } = yield* countedTool("owner_tool");
      const classified: string[] = [];
      const run = Effect.fnUntraced(function* (argumentsJson: string) {
        const gate = yield* makePermissionGateHook(
          yield* binding(session, "owner_tool", "classifier"),
        ).pipe(
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
      expect(yield* runs).toBe(1);
      yield* run('{"action":"dangerous"}');
      expect(classified).toEqual([
        `${session}:{"action":"read"}`,
        `${session}:{"action":"dangerous"}`,
      ]);
      expect(yield* runs).toBe(1);
      expect(yield* reviews.latest(session, "repeat-id")).toMatchObject({
        input: '{"action":"dangerous"}',
        decision: "block",
      });
    }),
  );

  it.effect("ask-every-call cannot apply a previous approval to a different tool", () =>
    Effect.gen(function* () {
      const session = yield* freshSession;
      const reviews = yield* PermissionReviews;
      const original = yield* reviews.record({
        sessionId: session,
        toolCallId: "reused-id",
        toolName: "old_tool",
        input: "{}",
        decision: "approved",
        decidedBy: "user",
        reason: "fixture original tool approval",
      });
      const gate = yield* makePermissionGateHook(yield* binding(session, "new_tool", "user"));
      const { tool, runs } = yield* countedTool("new_tool");
      yield* gatedRun(gate, tool, "reused-id", "{}");
      expect(yield* runs).toBe(0);
      expect(yield* reviews.latest(session, "reused-id")).toEqual(original);
    }),
  );

  it.effect(
    "ask-every-call preserves exact approvals but denies changed input without rewriting evidence",
    () =>
      Effect.gen(function* () {
        const session = yield* freshSession;
        const reviews = yield* PermissionReviews;
        const original = yield* reviews.record({
          sessionId: session,
          toolCallId: "approved-id",
          toolName: "owner_tool",
          input: '{"action":"read"}',
          decision: "approved",
          decidedBy: "user",
          reason: "fixture exact approved action",
        });
        const { tool, runs } = yield* countedTool("owner_tool");
        const run = Effect.fnUntraced(function* (argumentsJson: string) {
          const gate = yield* makePermissionGateHook(yield* binding(session, "owner_tool", "user"));
          yield* gatedRun(gate, tool, "approved-id", argumentsJson);
        });
        yield* run(original.input);
        expect(yield* runs).toBe(1);
        expect(yield* reviews.latest(session, "approved-id")).toEqual(original);
        yield* run('{"action":"write"}');
        expect(yield* runs).toBe(1);
        expect(yield* reviews.latest(session, "approved-id")).toEqual(original);
      }),
  );
});
