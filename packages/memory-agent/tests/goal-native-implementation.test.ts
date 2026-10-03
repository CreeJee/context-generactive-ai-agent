import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { createGoalNativeImplementations } from "../src/agent/goal-native-implementation.ts";
import { makeAgentChatImplementation } from "../src/agent/chat.ts";
import { Database } from "../src/db/database.ts";
import { Nodes } from "../src/memory/nodes.ts";
import type { NormalizedStreamEvent } from "../src/oauth/protocol.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { testRuntime } from "./support/runtime.ts";

const goal = {
  statement: "native implementation identity",
  outcomes: ["answer"],
  constraints: [],
  nonGoals: [],
  assumptions: [],
  openQuestions: [],
  status: "active" as const,
};

test("owner-local native references are retained by identity, never runtime or account", () => {
  const owner = createGoalNativeImplementations();
  const first = owner.forGoal("goal-a");
  expect(owner.forGoal("goal-a")).toBe(first);
  expect(owner.forGoal("goal-b")).not.toBe(first);
  const selection = { provider: "openai" as const, model: "test-model", reasoningEffort: "low" };
  const acquired: number[] = [];
  const dependencies = (account: number) => ({
    client: () => {
      acquired.push(account);
      return {
        stream: async function* (): AsyncGenerator<NormalizedStreamEvent> {
          yield { type: "text", text: String(account) };
        },
      };
    },
  });
  const a = first.openai.bind(dependencies(1));
  const b = first.openai.bind(dependencies(2));
  expect(a).not.toBe(b);
  expect(a.adapter(selection)).not.toBe(b.adapter(selection));
  expect(acquired).toEqual([1, 2]);
  expect(createGoalNativeImplementations().forGoal("goal-a")).not.toBe(first);
});

test("one native AgentChat owner executes two Goal identities with fresh clients and amendment retention", async () => {
  const { runtime, project, session, provider } = await testRuntime({ testProvider: {} });
  await provider!.select(runtime);
  const services = await runtime.runPromise(
    Effect.all({
      registry: ProviderRegistry,
      workflows: Workflows,
      sessions: Sessions,
      db: Database,
      nodes: Nodes,
    }),
  );
  const second = await runtime.runPromise(services.sessions.create(project.id));
  const ids: string[] = [];
  for (const target of [session, second]) {
    await runtime.runPromise(services.workflows.setPhase(target.id, "goal"));
    await runtime.runPromise(services.workflows.updateGoal(target.id, goal));
    ids.push(
      String(
        services.db.sqlite
          .prepare("SELECT goal_instance_id FROM workflow_goal_identities WHERE session_id = ?")
          .get(target.id)?.goal_instance_id,
      ),
    );
  }
  expect(ids[0]).not.toBe(ids[1]);
  await runtime.runPromise(
    services.workflows.updateGoal(session.id, { ...goal, statement: "amended method context" }),
  );
  expect(
    String(
      services.db.sqlite
        .prepare("SELECT goal_instance_id FROM workflow_goal_identities WHERE session_id = ?")
        .get(session.id)?.goal_instance_id,
    ),
  ).toBe(ids[0]);
  const acquired: number[] = [];
  const released: number[] = [];
  await runtime.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const chat = yield* makeAgentChatImplementation();
        for (const [index, target] of [session, second, session].entries()) {
          const response = yield* chat.handle(
            new Request("http://127.0.0.1/api/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                threadId: target.id,
                runId: crypto.randomUUID(),
                messages: [
                  { id: `user-${index + 1}`, role: "user", content: `hello-${index + 1}` },
                ],
                tools: [],
                context: [],
              }),
            }),
            target.id,
          );
          expect(response.status).toBe(200);
          expect(yield* Effect.promise(() => response.text())).toContain(`answer-${index + 1}`);
          expect(
            services.nodes
              .session(target.id)
              .filter((node) => node.kind === "assistant")
              .map((node) => node.text),
          ).toContain(`answer-${index + 1}`);
        }
      }).pipe(
        Effect.provideService(ProviderRegistry, {
          ...services.registry,
          subscriptionDependencies: () =>
            Effect.sync(() => {
              const account = acquired.length + 1;
              acquired.push(account);
              return {
                client: () => ({
                  releaseRun: () => released.push(account),
                  stream: async function* (): AsyncGenerator<NormalizedStreamEvent> {
                    yield { type: "text", text: `answer-${account}` };
                  },
                }),
              };
            }),
        }),
      ),
    ),
  );
  expect(acquired).toEqual([1, 2, 3]);
  expect(released).toEqual([1, 2, 3]);
  expect(
    services.nodes
      .session(session.id)
      .filter((node) => node.kind === "assistant")
      .map((node) => node.text),
  ).toEqual(["answer-1", "answer-3"]);
  expect(
    services.nodes
      .session(second.id)
      .filter((node) => node.kind === "assistant")
      .map((node) => node.text),
  ).toEqual(["answer-2"]);
  expect(provider!.adapter.invocations).toHaveLength(0);
});
