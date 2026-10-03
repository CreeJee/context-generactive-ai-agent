import { chat, toolDefinition } from "@tanstack/ai";
import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
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

test("Goal factory references bind fresh native SDK capabilities and deferred attribution", async () => {
  const registry = createGoalNativeImplementations();
  const implementation = registry.forGoal("stable-goal");
  expect(registry.forGoal("stable-goal")).toBe(implementation);
  expect(registry.forGoal("new-goal")).not.toBe(implementation);
  const owners = [await testRuntime(), await testRuntime()];
  const executed: number[] = [];
  for (const [index, owner] of owners.entries()) {
    const env = await owner.runtime.runPromise(
      Effect.all({
        search: MemorySearch,
        nodes: Nodes,
        graph: Graph,
        interpretations: Interpretations,
        knowledge: KnowledgePromotions,
      }),
    );
    const reviews = await owner.runtime.runPromise(PermissionReviews);
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
    const recording = await owner.runtime.runPromise(
      implementation.makeRecordingMiddleware({
        projectId: owner.project.id,
        sessionId: owner.session.id,
        runId,
        get userNodeId() {
          reads++;
          return admittedUser;
        },
      }),
    );
    const gate = await owner.runtime.runPromise(
      implementation
        .makePermissionGateMiddleware({
          project: owner.project,
          sessionId: owner.session.id,
          selection: { provider: "openai", model: "scripted-1", reasoningEffort: "none" },
          gated: new Set(["probe"]),
          decider: "classifier",
        })
        .pipe(
          Effect.provideService(PermissionClassifier, {
            classify: async () => ({
              decision: index === 0 ? "allow" : "block",
              decidedBy: "classifier",
              reason: runId,
            }),
          }),
        ),
    );
    expect(reads).toBe(0);
    const user = env.nodes.append({
      projectId: owner.project.id,
      sessionId: owner.session.id,
      kind: "user",
      text: runId,
    });
    admittedUser = user.id;
    expect(await memory.tools[1].execute!({ id: user.id })).toMatchObject({ text: runId });
    if (memory.tools.length !== 6) throw new Error("Expected run-bound memory tools");
    const useMemory = memory.tools[5];
    expect(() => useMemory.execute!({ memoryNodeIds: [user.id] })).toThrow(
      "Only promoted memories retrieved in this run can be used",
    );
    await expect(
      memory.tools[4].execute!({
        claimId: "unadopted",
        taskId: "task",
        attemptId: "attempt",
        evidenceRefIds: [],
        proposedText: "memory",
        resolvedText: "memory",
        disposition: "save",
      }),
    ).rejects.toMatchObject({ reason: "claim_not_adopted" });
    const tool = toolDefinition({ name: "probe", description: "native goal probe" }).server(() => {
      executed.push(index);
      return runId;
    });
    await chat({
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
    });
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
});

test("actual Goal-bound native AgentChat turns bypass bound recording and memory methods", async () => {
  const { runtime, project, session, provider } = await testRuntime({ testProvider: {} });
  await provider!.select(runtime);
  await runtime.runPromise(
    Effect.flatMap(Projects, (projects) => projects.setPermissionMode(project.id, "auto")),
  );
  const workflows = await runtime.runPromise(Workflows);
  await runtime.runPromise(workflows.setPhase(session.id, "goal"));
  const goal = {
    statement: "native capabilities",
    outcomes: ["answer"],
    constraints: [],
    nonGoals: [],
    assumptions: [],
    openQuestions: [],
    status: "active" as const,
  };
  await runtime.runPromise(workflows.updateGoal(session.id, goal));
  const services = await runtime.runPromise(
    Effect.all({
      registry: ProviderRegistry,
      recorder: Recorder,
      gate: PermissionGate,
      memory: MemoryTools,
      nodes: Nodes,
    }),
  );
  let account = 0;
  const unsupported = () => {
    throw new Error("Goal must not use service-bound forRun");
  };
  await runtime.runPromise(
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
              body: JSON.stringify({
                threadId: session.id,
                runId: crypto.randomUUID(),
                messages: [{ id: `user-${index}`, role: "user", content: `hello-${index}` }],
                tools: [],
                context: [],
              }),
            }),
            session.id,
          );
          const response = yield* Effect.promise(() => Effect.runPromise(operation));
          expect(response.status).toBe(200);
          expect(yield* Effect.promise(() => response.text())).toContain(`native-answer-${index}`);
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
                  stream: async function* (): AsyncGenerator<NormalizedStreamEvent> {
                    yield { type: "text", text: `native-answer-${current}` };
                  },
                }),
              };
            }),
        }),
      ),
    ),
  );
  const assistants = services.nodes.session(session.id).filter((node) => node.kind === "assistant");
  expect(assistants.map((node) => node.text)).toEqual(["native-answer-1", "native-answer-2"]);
  expect(new Set(assistants.map((node) => node.runId)).size).toBe(2);
  const replies = assistants.map(
    (node) => services.nodes.edgesOf(node.id).find((edge) => edge.kind === "reply")?.toId,
  );
  expect(new Set(replies).size).toBe(2);
  expect(provider!.adapter.invocations).toHaveLength(0);
});
