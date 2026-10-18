import { chat, toolDefinition } from "@tanstack/ai";
import { Array as EffectArray, Cause, Effect, HashSet, Schema, Stream } from "effect";
import { expect } from "vite-plus/test";
import { makeAgentChatImplementation } from "../../src/agent/chat.ts";
import { createGoalNativeImplementations } from "../../src/agent/goal-native-implementation.ts";
import { Database } from "../../src/db/database.ts";
import { Graph } from "../../src/memory/graph.ts";
import { Interpretations } from "../../src/memory/interpretations.ts";
import { KnowledgePromotions } from "../../src/memory/knowledge.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { Recorder } from "../../src/memory/record.ts";
import { MemorySearch } from "../../src/memory/search.ts";
import type { NormalizedStreamEvent } from "../../src/oauth/protocol.ts";
import { PermissionClassifier } from "../../src/permissions/classifier.ts";
import { PermissionGate } from "../../src/permissions/gate.ts";
import { PermissionReviews } from "../../src/permissions/reviews.ts";
import { Projects } from "../../src/projects/projects.ts";
import { ProviderRegistry } from "../../src/providers/registry.ts";
import { nativeStream } from "../../src/runtime/native-stream.ts";
import { ScriptedTextAdapter } from "../../src/testing/scripted-adapter.ts";
import { permissionReviewInterrupt } from "../../src/tools/definitions.ts";
import { MemoryTools } from "../../src/tools/memory.ts";
import { Workflows } from "../../src/workflow/workflow.ts";
import { selectTestModel } from "../support/provider.ts";
import { TestEnv, freshSession, testAgent } from "../support/test-env.ts";

const goal = {
  statement: "native capabilities",
  outcomes: ["answer"],
  constraints: [],
  nonGoals: [],
  assumptions: [],
  openQuestions: [],
  status: "active" as const,
};

const sdkCall = <A>(call: () => A | PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  });

type GoalImplementation = ReturnType<ReturnType<typeof createGoalNativeImplementations>["forGoal"]>;

/**
 * One owner binds the shared Goal implementation to its own services for one run. The probe tool
 * is allowed for the first owner and blocked for the second, so each permission decision proves
 * which owner's gate ran.
 */
const ownerRun = Effect.fnUntraced(function* (
  implementation: GoalImplementation,
  index: number,
  executed: number[],
) {
  const { project } = yield* TestEnv;
  const session = yield* freshSession;
  const env = {
    search: yield* MemorySearch,
    nodes: yield* Nodes,
    graph: yield* Graph,
    interpretations: yield* Interpretations,
    knowledge: yield* KnowledgePromotions,
  };
  const reviews = yield* PermissionReviews;
  let reads = 0;
  let admittedUser = "not-admitted";
  const runId = `${session}:native-${index}`;
  const memory = implementation.createMemoryTools(env, project.id, {
    projectId: project.id,
    sessionId: session,
    runId,
    userNodeId: () => {
      reads++;
      return admittedUser;
    },
  });
  const recording = yield* implementation.makeRecordingMiddleware({
    projectId: project.id,
    sessionId: session,
    runId,
    get userNodeId() {
      reads++;
      return admittedUser;
    },
  });
  const gate = yield* implementation
    .makePermissionGateMiddleware({
      project,
      sessionId: session,
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
    );
  // Attribution is deferred: nothing reads the user node before the run admits it.
  expect(reads).toBe(0);
  const user = yield* env.nodes.append({
    projectId: project.id,
    sessionId: session,
    kind: "user",
    text: runId,
  });
  admittedUser = user.id;
  expect(yield* sdkCall(() => memory.tools[1].execute!({ id: user.id }))).toMatchObject({
    text: runId,
  });
  if (memory.tools.length !== 6) return expect.unreachable("Expected run-bound memory tools");
  const useMemory = memory.tools[5];
  const promoteMemory = memory.tools[4].execute!;
  expect(() => useMemory.execute!({ memoryNodeIds: [user.id] })).toThrow(
    "Only promoted memories retrieved in this run can be used",
  );
  // A promotion that unexpectedly succeeds fails the test as a defect.
  const refused = yield* sdkCall(() =>
    promoteMemory({
      claimId: "unadopted",
      taskId: "task",
      attemptId: "attempt",
      evidenceRefIds: [],
      proposedText: "memory",
      resolvedText: "memory",
      disposition: "save",
    }),
  ).pipe(Effect.flip, Effect.orDie);
  expect(refused.cause).toMatchObject({ reason: "claim_not_adopted" });
  const tool = toolDefinition({ name: "probe", description: "native goal probe" }).server(() => {
    executed.push(index);
    return runId;
  });
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
  expect(yield* reviews.latest(session, "shared-call")).toMatchObject({
    decision: index === 0 ? "allow" : "block",
    reason: runId,
  });
  expect(yield* env.nodes.toolNode(session, "tool_result", "shared-call")).toMatchObject({
    runId,
    detail: { ok: index === 0, permission: { reason: runId } },
  });
  for (const assistant of (yield* env.nodes.session(session)).filter(
    (node) => node.kind === "assistant",
  )) {
    expect(yield* env.nodes.edgesOf(assistant.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "reply", toId: user.id })]),
    );
  }
  expect(reads).toBeGreaterThan(1);
  // The run records only into its own session.
  expect(
    (yield* Database).sqlite
      .prepare("SELECT count(*) AS n FROM nodes WHERE run_id = ? AND session_id != ?")
      .get(runId, session),
  ).toEqual({ n: 0 });
});

// The second owner is a reopened agent, so this block reads services through `env.use` only.
testAgent()("Goal native factory across owners", (it) => {
  it.effect(
    "Goal factory references bind fresh native SDK capabilities and deferred attribution",
    () =>
      Effect.gen(function* () {
        const env = yield* TestEnv;
        const implementation = createGoalNativeImplementations().forGoal("stable-goal");
        const executed: number[] = [];
        yield* env.use(ownerRun(implementation, 0, executed));
        yield* env.reopen;
        yield* env.use(ownerRun(implementation, 1, executed));
        expect(executed).toEqual([0]);
      }),
  );
});

/** A subscription client per acquired account, answering with that account's number. */
const accountClients = (registry: ProviderRegistry["Service"]) => {
  const acquired: number[] = [];
  const released: number[] = [];
  const service: ProviderRegistry["Service"] = {
    ...registry,
    subscriptionDependencies: () =>
      Effect.sync(() => {
        const account = acquired.length + 1;
        acquired.push(account);
        return {
          client: () => ({
            releaseRun: () => released.push(account),
            stream: (): AsyncGenerator<NormalizedStreamEvent> =>
              nativeStream(
                Stream.succeed<NormalizedStreamEvent>({
                  type: "text",
                  text: `native-answer-${account}`,
                }),
              ),
          }),
        };
      }),
  };
  return { acquired, released, service };
};

const goalInstance = (db: Database["Service"], session: string) =>
  Schema.decodeUnknownEffect(Schema.Struct({ goal_instance_id: Schema.String }))(
    db.sqlite
      .prepare("SELECT goal_instance_id FROM workflow_goal_identities WHERE session_id = ?")
      .get(session),
  ).pipe(Effect.map((row) => row.goal_instance_id));

// The project switches to auto permission mode, so these turns get their own agent.
testAgent({ testProvider: {} })("native AgentChat Goal turns", (it) => {
  it.effect(
    "one owner runs two Goal identities with fresh clients, amendment retention and no bound services",
    () =>
      Effect.gen(function* () {
        const { project, provider } = yield* TestEnv;
        const db = yield* Database;
        const workflows = yield* Workflows;
        const nodes = yield* Nodes;
        yield* selectTestModel();
        yield* (yield* Projects).setPermissionMode(project.id, "auto");
        const first = yield* freshSession;
        const second = yield* freshSession;
        for (const session of [first, second]) {
          yield* workflows.setPhase(session, "goal");
          yield* workflows.updateGoal(session, goal);
        }
        const firstGoal = yield* goalInstance(db, first);
        expect(yield* goalInstance(db, second)).not.toBe(firstGoal);
        const clients = accountClients(yield* ProviderRegistry);
        const unsupported = () => {
          throw new Error("Goal must not use service-bound forRun");
        };
        const gate = yield* PermissionGate;
        const recorder = yield* Recorder;
        const memory = yield* MemoryTools;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const agent = yield* makeAgentChatImplementation();
            const turn = Effect.fnUntraced(function* (session: string, index: number) {
              // Compile-sensitive public contract: no native service requirements leak to raw
              // SDK/route callers; the operation runs with no provided Context.
              const operation: Effect.Effect<
                Response,
                Effect.Error<ReturnType<typeof agent.handle>>
              > = agent.handle(
                new Request("http://127.0.0.1/api/chat", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                    threadId: session,
                    runId: `${session}:native-${index}`,
                    messages: [{ id: `user-${index}`, role: "user", content: `hello-${index}` }],
                    tools: [],
                    context: [],
                  }),
                }),
                session,
              );
              const response = yield* operation;
              expect(response.status).toBe(200);
              expect(yield* sdkCall(() => response.text())).toContain(`native-answer-${index}`);
            });
            yield* turn(first, 1);
            yield* turn(second, 2);
            // Amending the Goal keeps its identity, and so the same native implementation.
            yield* workflows.updateGoal(first, { ...goal, statement: "amended goal" });
            expect(yield* goalInstance(db, first)).toBe(firstGoal);
            yield* turn(first, 3);
          }).pipe(
            Effect.provideService(PermissionGate, { ...gate, forRun: unsupported }),
            Effect.provideService(Recorder, { ...recorder, forRun: unsupported }),
            Effect.provideService(MemoryTools, { ...memory, forRun: unsupported }),
            Effect.provideService(ProviderRegistry, clients.service),
          ),
        );
        expect(clients.acquired).toEqual([1, 2, 3]);
        expect(clients.released).toEqual([1, 2, 3]);
        const assistants = (session: string) =>
          Effect.map(nodes.session(session), (nodes) =>
            nodes.filter((node) => node.kind === "assistant"),
          );
        expect((yield* assistants(first)).map((node) => node.text)).toEqual([
          "native-answer-1",
          "native-answer-3",
        ]);
        expect((yield* assistants(second)).map((node) => node.text)).toEqual(["native-answer-2"]);
        const all = [...(yield* assistants(first)), ...(yield* assistants(second))];
        expect(EffectArray.dedupe(all.map((node) => node.runId))).toHaveLength(3);
        const replies = yield* Effect.forEach(all, (node) =>
          Effect.map(
            nodes.edgesOf(node.id),
            (edges) => edges.find((edge) => edge.kind === "reply")?.toId,
          ),
        );
        expect(EffectArray.dedupe(replies)).toHaveLength(3);
        expect(provider!.adapter.invocations).toHaveLength(0);
      }),
  );
});
