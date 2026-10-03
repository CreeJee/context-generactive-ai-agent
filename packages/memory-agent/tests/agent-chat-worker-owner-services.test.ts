import { threadId } from "node:worker_threads";
import { Effect, Layer } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { Database } from "../src/db/database.ts";
import { Embedder } from "../src/memory/embedding/embedder.ts";
import { Indexer } from "../src/memory/embedding/indexer.ts";
import { fakeVector } from "../src/testing/fake-embedder.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { testRuntime } from "./support/runtime.ts";

const ownership = vi.hoisted(() => {
  const sdkWorkerIds: number[] = [];
  return {
    databaseOpens: 0,
    activeDatabases: 0,
    maxActiveDatabases: 0,
    sdkWorkerIds,
  };
});

// Observe actual constructors; preserve real SQLite/Worker behavior. The SDK
// worker uses its own Node module graph, not these owner-side Vitest proxies.
vi.mock("node:sqlite", async (load) => {
  const original = await load<typeof import("node:sqlite")>();
  return {
    ...original,
    DatabaseSync: class extends original.DatabaseSync {
      constructor(...args: ConstructorParameters<typeof original.DatabaseSync>) {
        super(...args);
        ownership.databaseOpens++;
        ownership.activeDatabases++;
        ownership.maxActiveDatabases = Math.max(
          ownership.maxActiveDatabases,
          ownership.activeDatabases,
        );
      }
      override close() {
        super.close();
        ownership.activeDatabases--;
      }
    },
  };
});
vi.mock("node:worker_threads", async (load) => {
  const original = await load<typeof import("node:worker_threads")>();
  return {
    ...original,
    Worker: class extends original.Worker {
      constructor(...args: ConstructorParameters<typeof original.Worker>) {
        super(...args);
        if (String(args[0]).endsWith("/full-loop-worker.ts"))
          ownership.sdkWorkerIds.push(this.threadId);
      }
    },
  };
});

test("actual SDK worker turn keeps the DB and embedding backend in one central owner", async () => {
  const previous = process.env.CONTEXT_AGENT_GOAL_WORKER;
  process.env.CONTEXT_AGENT_GOAL_WORKER = "1";
  let backendInitializations = 0;
  let activeBackends = 0;
  let maxActiveBackends = 0;
  const embeddingCalls: Array<{ threadId: number; texts: readonly string[] }> = [];
  const query = "central owner embedding proof";
  const embedder = Layer.effect(
    Embedder,
    Effect.acquireRelease(
      Effect.sync(() => {
        backendInitializations++;
        activeBackends++;
        maxActiveBackends = Math.max(maxActiveBackends, activeBackends);
        return {
          identity: "fake-trigram-64",
          dimensions: 64,
          embed: (texts: readonly string[]) =>
            Effect.sync(() => {
              embeddingCalls.push({ threadId, texts: [...texts] });
              return texts.map(fakeVector);
            }),
          runtime: () => ({ kind: "other" as const }),
        };
      }),
      () =>
        Effect.sync(() => {
          activeBackends--;
        }),
    ),
  );
  try {
    const context = await testRuntime({
      embedder,
      testProvider: {
        responder: (invocation) => {
          if (!invocation.messages.some((message) => message.role === "tool"))
            return {
              toolCalls: [
                {
                  id: "owner-embed-call",
                  name: "find_memory",
                  arguments: JSON.stringify({ query }),
                },
              ],
            };
          return { text: "central owner complete" };
        },
      },
    });
    await context.provider!.select(context.runtime);
    const { chat, db, workflows } = await context.runtime.runPromise(
      Effect.all({ chat: AgentChat, db: Database, workflows: Workflows }),
    );
    await context.runtime.runPromise(
      workflows.updateGoal(context.session.id, {
        statement: "Keep storage and embedding owned centrally",
        outcomes: ["One owner backend across separated SDK execution"],
        constraints: [],
        nonGoals: [],
        assumptions: [],
        openQuestions: [],
        status: "active",
      }),
    );
    const response = await context.runtime.runPromise(
      chat.handle(
        new Request("http://localhost/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Run-Id": "central-services" },
          body: JSON.stringify({
            threadId: context.session.id,
            runId: "central-services",
            messages: [{ id: "m1", role: "user", content: "search memory" }],
            tools: [],
            context: [],
          }),
        }),
        context.session.id,
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("central owner complete");
    const indexer = await context.runtime.runPromise(Indexer);
    await context.runtime.runPromise(indexer.indexAll());
    expect(await context.runtime.runPromise(indexer.pending)).toBe(0);
    const storedVectors = db.sqlite.prepare("SELECT * FROM node_vectors ORDER BY node_seq").all();
    expect(storedVectors.length).toBeGreaterThan(0);
    const callsBeforeReopen = embeddingCalls.length;
    expect(ownership.sdkWorkerIds).toHaveLength(1);
    expect(ownership.sdkWorkerIds[0]).not.toBe(threadId);
    expect(ownership.databaseOpens).toBe(1);
    expect(ownership.activeDatabases).toBe(1);
    expect(ownership.maxActiveDatabases).toBe(1);
    expect(backendInitializations).toBe(1);
    expect(activeBackends).toBe(1);
    expect(maxActiveBackends).toBe(1);
    expect(embeddingCalls.some((call) => call.texts.some((text) => text.includes(query)))).toBe(
      true,
    );
    expect(embeddingCalls.every((call) => call.threadId === threadId)).toBe(true);
    expect(
      db.sqlite.prepare("SELECT status FROM chat_runs WHERE run_id = 'central-services'").get(),
    ).toEqual({ status: "completed" });
    const reopened = await context.reopen();
    const restored = await reopened.runPromise(Database);
    const restoredIndexer = await reopened.runPromise(Indexer);
    expect(await reopened.runPromise(restoredIndexer.indexAll())).toBe(0);
    expect(embeddingCalls).toHaveLength(callsBeforeReopen);
    expect(restored.sqlite.prepare("SELECT * FROM node_vectors ORDER BY node_seq").all()).toEqual(
      storedVectors,
    );
    expect(
      restored.sqlite
        .prepare("SELECT status FROM chat_runs WHERE run_id = 'central-services'")
        .get(),
    ).toEqual({ status: "completed" });
    expect(ownership.databaseOpens).toBe(2);
    expect(ownership.maxActiveDatabases).toBe(1);
    expect(backendInitializations).toBe(2);
    expect(maxActiveBackends).toBe(1);
    expect(ownership.sdkWorkerIds).toHaveLength(1);
  } finally {
    if (previous === undefined) delete process.env.CONTEXT_AGENT_GOAL_WORKER;
    else process.env.CONTEXT_AGENT_GOAL_WORKER = previous;
  }
}, 20000);
