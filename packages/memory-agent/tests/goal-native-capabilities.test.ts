import { nativeStream } from "../src/runtime/native-stream.ts";
import { Stream } from "effect";
import { NodeCrypto } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Array as EffectArray } from "effect";
import { HashSet } from "effect";
import { chat, toolDefinition } from "@tanstack/ai";
import { Cause, Crypto, Layer, Schema, Effect } from "effect";
import { expect } from "vite-plus/test";
import { makeAgentChatImplementation } from "../src/agent/chat.ts";
import { createGoalNativeImplementations } from "../src/agent/goal-native-implementation.ts";
import { Graph } from "../src/memory/graph.ts";
import { Interpretations } from "../src/memory/interpretations.ts";
import { KnowledgePromotions } from "../src/memory/knowledge.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { Recorder } from "../src/memory/record.ts";
import { MemorySearch } from "../src/memory/search.ts";
import type { NormalizedStreamEvent } from "../src/oauth/protocol.ts";
import { PermissionClassifier } from "../src/permissions/classifier.ts";
import { PermissionReviews } from "../src/permissions/reviews.ts";
import { PermissionGate } from "../src/permissions/gate.ts";
import { Projects } from "../src/projects/projects.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { ScriptedTextAdapter } from "../src/testing/scripted-adapter.ts";
import { permissionReviewInterrupt } from "../src/tools/definitions.ts";
import { MemoryTools } from "../src/tools/memory.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { testRuntime } from "./support/runtime.ts";

it.live("Goal factory references bind fresh native SDK capabilities and deferred attribution", () =>
  withCrypto(
    Effect.gen(function* () {
      const registry = createGoalNativeImplementations();
      const implementation = registry.forGoal("stable-goal");
      expect(registry.forGoal("stable-goal")).toBe(implementation);
      expect(registry.forGoal("new-goal")).not.toBe(implementation);
      const owners = [yield* sdkCall(() => testRuntime()), yield* sdkCall(() => testRuntime())];
      const executed: number[] = [];
      for (const [index, owner] of owners.entries()) {
        const env = yield* Effect.provideContext(
          Effect.all({
            search: MemorySearch,
            nodes: Nodes,
            graph: Graph,
            interpretations: Interpretations,
            knowledge: KnowledgePromotions,
          }),
          yield* owner.runtime.contextEffect,
        );
        const reviews = yield* Effect.provideContext(
          PermissionReviews,
          yield* owner.runtime.contextEffect,
        );
        let reads = 0;
        let admittedUser = "not-admitted";
        const runId = `native-run-${index}`;
        const memory = implementation.createMemoryTools(env, owner.project.id, {
          projectId: owner.project.id,
          sessionId: owner.session.id,
          runId,
          userNodeId: () => {
            reads++;
            return admittedUser;
          },
        });
        const recording = yield* Effect.provideContext(
          implementation.makeRecordingMiddleware({
            projectId: owner.project.id,
            sessionId: owner.session.id,
            runId,
            get userNodeId() {
              reads++;
              return admittedUser;
            },
          }),
          yield* owner.runtime.contextEffect,
        );
        const gate = yield* Effect.provideContext(
          implementation
            .makePermissionGateMiddleware({
              project: owner.project,
              sessionId: owner.session.id,
              selection: { provider: "openai", model: "scripted-1", reasoningEffort: "none" },
              gated: HashSet.fromIterable(["probe"]),
              decider: "classifier",
            })
            .pipe(
              Effect.provideService(PermissionClassifier, {
                classify: () =>
                  Promise.resolve({
                    decision: index === 0 ? "allow" : "block",
                    decidedBy: "classifier",
                    reason: runId,
                  }),
              }),
            ),
          yield* owner.runtime.contextEffect,
        );
        expect(reads).toBe(0);
        const user = env.nodes.append({
          projectId: owner.project.id,
          sessionId: owner.session.id,
          kind: "user",
          text: runId,
        });
        admittedUser = user.id;
        expect(yield* sdkCall(() => memory.tools[1].execute!({ id: user.id }))).toMatchObject({
          text: runId,
        });
        if (memory.tools.length !== 6) throw new Error("Expected run-bound memory tools");
        const useMemory = memory.tools[5];
        const promoteMemory = memory.tools[4].execute!;
        expect(() => useMemory.execute!({ memoryNodeIds: [user.id] })).toThrow(
          "Only promoted memories retrieved in this run can be used",
        );
        yield* sdkCall(() =>
          expect(
            promoteMemory({
              claimId: "unadopted",
              taskId: "task",
              attemptId: "attempt",
              evidenceRefIds: [],
              proposedText: "memory",
              resolvedText: "memory",
              disposition: "save",
            }),
          ).rejects.toMatchObject({ reason: "claim_not_adopted" }),
        );
        const tool = toolDefinition({ name: "probe", description: "native goal probe" }).server(
          () => {
            executed.push(index);
            return runId;
          },
        );
        yield* sdkCall(() =>
          chat({
            adapter: new ScriptedTextAdapter([
              { toolCalls: [{ id: "shared-call", name: "probe", arguments: "{}" }] },
              { text: `answer-${index}` },
            ]),
            messages: [{ role: "user", content: runId }],
            tools: [tool],
            runId,
            interrupts: [permissionReviewInterrupt],
            middleware: [gate, recording],
            stream: false,
          }),
        );
        expect(reviews.latest(owner.session.id, "shared-call")).toMatchObject({
          decision: index === 0 ? "allow" : "block",
          reason: runId,
        });
        expect(env.nodes.toolNode(owner.session.id, "tool_result", "shared-call")).toMatchObject({
          runId,
          detail: { ok: index === 0, permission: { reason: runId } },
        });
        for (const assistant of env.nodes
          .session(owner.session.id)
          .filter((node) => node.kind === "assistant")) {
          expect(env.nodes.edgesOf(assistant.id)).toEqual(
            expect.arrayContaining([expect.objectContaining({ kind: "reply", toId: user.id })]),
          );
        }
        expect(reads).toBeGreaterThan(1);
        expect(env.nodes.session(owners[1 - index]!.session.id)).toEqual([]);
      }
      expect(executed).toEqual([0]);
    }),
  ),
);

it.live("actual Goal-bound native AgentChat turns bypass bound recording and memory methods", () =>
  withCrypto(
    Effect.gen(function* () {
      const { runtime, project, session, provider } = yield* sdkCall(() =>
        testRuntime({ testProvider: {} }),
      );
      yield* sdkCall(() => provider!.select(runtime));
      yield* Effect.provideContext(
        Effect.flatMap(Projects, (projects) => projects.setPermissionMode(project.id, "auto")),
        yield* runtime.contextEffect,
      );
      const workflows = yield* Effect.provideContext(Workflows, yield* runtime.contextEffect);
      yield* Effect.provideContext(
        workflows.setPhase(session.id, "goal"),
        yield* runtime.contextEffect,
      );
      const goal = {
        statement: "native capabilities",
        outcomes: ["answer"],
        constraints: [],
        nonGoals: [],
        assumptions: [],
        openQuestions: [],
        status: "active" as const,
      };
      yield* Effect.provideContext(
        workflows.updateGoal(session.id, goal),
        yield* runtime.contextEffect,
      );
      const services = yield* Effect.provideContext(
        Effect.all({
          registry: ProviderRegistry,
          recorder: Recorder,
          gate: PermissionGate,
          memory: MemoryTools,
          nodes: Nodes,
        }),
        yield* runtime.contextEffect,
      );
      let account = 0;
      const unsupported = () => {
        throw new Error("Goal must not use service-bound forRun");
      };
      yield* Effect.provideContext(
        Effect.scoped(
          Effect.gen(function* () {
            const agent = yield* makeAgentChatImplementation();
            for (const index of [1, 2]) {
              if (index === 2)
                yield* workflows.updateGoal(session.id, { ...goal, statement: "amended goal" });
              // Compile-sensitive public contract: no native service requirements leak
              // to raw SDK/route callers; execution below has no provided Context.
              const operation: Effect.Effect<
                Response,
                Effect.Error<ReturnType<typeof agent.handle>>
              > = agent.handle(
                new Request("http://127.0.0.1/api/chat", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                    threadId: session.id,
                    runId: yield* (yield* Crypto.Crypto).randomUUIDv4(),
                    messages: [{ id: `user-${index}`, role: "user", content: `hello-${index}` }],
                    tools: [],
                    context: [],
                  }),
                }),
                session.id,
              );
              const response = yield* operation;
              expect(response.status).toBe(200);
              expect(yield* Effect.promise(() => response.text())).toContain(
                `native-answer-${index}`,
              );
            }
          }).pipe(
            Effect.provideService(PermissionGate, { ...services.gate, forRun: unsupported }),
            Effect.provideService(Recorder, { ...services.recorder, forRun: unsupported }),
            Effect.provideService(MemoryTools, { ...services.memory, forRun: unsupported }),
            Effect.provideService(ProviderRegistry, {
              ...services.registry,
              subscriptionDependencies: () =>
                Effect.sync(() => {
                  const current = ++account;
                  return {
                    client: () => ({
                      stream: function (): AsyncGenerator<NormalizedStreamEvent> {
                        return nativeStream(
                          Stream.suspend(() =>
                            Stream.fromIterable(
                              (function* (): Generator<NormalizedStreamEvent> {
                                yield { type: "text", text: `native-answer-${current}` };
                              })(),
                            ),
                          ),
                        );
                      },
                    }),
                  };
                }),
            }),
          ),
        ),
        yield* runtime.contextEffect,
      );
      const assistants = services.nodes
        .session(session.id)
        .filter((node) => node.kind === "assistant");
      expect(assistants.map((node) => node.text)).toEqual(["native-answer-1", "native-answer-2"]);
      expect(EffectArray.dedupe(assistants.map((node) => node.runId)).length).toBe(2);
      const replies = assistants.map(
        (node) => services.nodes.edgesOf(node.id).find((edge) => edge.kind === "reply")?.toId,
      );
      expect(EffectArray.dedupe(replies).length).toBe(2);
      expect(provider!.adapter.invocations).toHaveLength(0);
    }),
  ),
);

const sdkCall = Effect.fn("GoalNativeTest.sdkCall")(<A>(call: () => A | PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);
const withCrypto = Effect.fn("GoalNativeTest.crypto")(function* <A, E, R>(
  program: Effect.Effect<A, E, R>,
) {
  const context = yield* Layer.build(NodeCrypto.layer);
  return yield* Effect.provideContext(program, context);
});
