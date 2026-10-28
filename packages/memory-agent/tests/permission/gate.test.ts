import { NodeCrypto } from "@effect/platform-node";
import { Context, Crypto, Effect, HashSet, Layer, Ref, Schema, Stream } from "effect";
import { assert, expect } from "vite-plus/test";
import type { StoredMessage } from "../../src/chat-store/schema.ts";
import type { ResumeEntry } from "../../src/loop/resume.ts";
import { RunFailed, runChat, type RunHook } from "../../src/loop/run.ts";
import { RunStore } from "../../src/loop/store.ts";
import { PermissionClassifier } from "../../src/permissions/classifier.ts";
import { makePermissionGateHook, type GateBinding } from "../../src/permissions/gate.ts";
import { PermissionReviews } from "../../src/permissions/reviews.ts";
import { scriptedModel } from "../../src/testing/scripted-model.ts";
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

  it.effect(
    "the Effect AI loop asks about a call the review is unsure of and runs it once approved",
    () =>
      Effect.gen(function* () {
        const session = yield* freshSession;
        const reviews = yield* PermissionReviews;
        const runs = yield* Ref.make(0);
        const hook = yield* makePermissionGateHook(
          yield* binding(session, "owner_tool", "classifier"),
        ).pipe(
          Effect.provideService(
            PermissionClassifier,
            classifier([], () => ({ decision: "ask", reason: "확인이 필요해요." })),
          ),
        );
        const services = yield* Layer.build(Layer.merge(RunStore.layer, NodeCrypto.layer));
        const store = Context.get(services, RunStore);
        const { model } = yield* scriptedModel([
          { toolCalls: [{ id: "gated", name: "owner_tool", arguments: "{}" }] },
          { text: "finished" },
        ]);
        const run = (
          runId: string,
          conversation: ReadonlyArray<StoredMessage>,
          resume: ReadonlyArray<ResumeEntry>,
        ) =>
          Stream.runCollect(
            runChat(
              {
                model,
                source: { provider: "scripted", api: "text", model: "scripted-1" },
                system: [],
                tools: [
                  runTool({
                    name: "owner_tool",
                    description: "permission gate fixture",
                    parameters: Schema.Struct({}),
                    handler: () =>
                      Effect.as(
                        Ref.update(runs, (count) => count + 1),
                        "executed",
                      ),
                  }),
                ],
                hooks: [hook],
                modelFailure: () => RunFailed.make({ message: "The model failed." }),
              },
              { threadId: session, runId, conversation, resume, cancel: Effect.never },
            ),
          ).pipe(Effect.provideContext(services));

        const first = (yield* run("run-1", [{ role: "user", content: "go" }], [])).at(-1);
        assert(first?.type === "RUN_FINISHED" && first.outcome?.type === "interrupt");
        const [asked] = first.outcome.interrupts;
        expect(asked).toMatchObject({
          reason: "permission_review",
          message: "확인이 필요해요.",
          metadata: {
            payload: {
              toolCallId: "gated",
              toolName: "owner_tool",
              arguments: "{}",
              askedBy: "review",
            },
          },
        });
        expect(yield* Ref.get(runs)).toBe(0);

        yield* run("run-2", yield* store.thread(session), [
          { interruptId: asked!.id, status: "resolved", payload: { approved: true } },
        ]);
        expect(yield* Ref.get(runs)).toBe(1);
        expect(yield* reviews.latest(session, "gated")).toMatchObject({
          decision: "approved",
          decidedBy: "user",
        });
      }).pipe(Effect.scoped),
  );
});
