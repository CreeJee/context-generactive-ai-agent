import { selectTestModel } from "./support/provider.ts";
import { it } from "@effect/vitest";
import { DatabaseSync } from "node:sqlite";
import { threadId } from "node:worker_threads";
import { Array, Effect, Layer, Schema } from "effect";
import { expect } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { Database } from "../src/db/database.ts";
import { Embedder } from "../src/memory/embedding/embedder.ts";
import { Indexer } from "../src/memory/embedding/indexer.ts";
import { fakeVector } from "../src/testing/fake-embedder.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { testRuntime } from "./support/runtime.ts";

it.live(
  "actual SDK worker turn keeps the DB and embedding backend in one central owner",
  () =>
    Effect.gen(function* () {
      const ownership = {
        databaseOpens: 0,
        activeDatabases: 0,
        maxActiveDatabases: 0,
        sdkWorkerIds: Array.empty<number>(),
      };
      class OwnerDatabase extends DatabaseSync {
        constructor(file: string) {
          super(file);
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
      }

      let backendInitializations = 0;
      let activeBackends = 0;
      let maxActiveBackends = 0;
      const embeddingCalls: globalThis.Array<{ threadId: number; texts: readonly string[] }> = [];
      const query = "central owner embedding proof";
      const embedder = Layer.effect(
        Embedder,
        Effect.acquireRelease(
          Effect.sync(() => {
            backendInitializations++;
            activeBackends++;
            maxActiveBackends = Math.max(maxActiveBackends, activeBackends);
            return {
              identity: "fake-trigram-384",
              dimensions: 384,
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
        const context = yield* Effect.promise(() =>
          testRuntime({
            openDatabase: (file) => new OwnerDatabase(file),
            goalWorker: { onWorker: (worker) => ownership.sdkWorkerIds.push(worker.threadId) },
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
          }),
        );
        yield* Effect.provideContext(selectTestModel(), yield* context.runtime.contextEffect);
        const { chat, db, workflows } = yield* Effect.provideContext(
          Effect.all({ chat: AgentChat, db: Database, workflows: Workflows }),
          yield* context.runtime.contextEffect,
        );
        yield* Effect.provideContext(
          workflows.updateGoal(context.session.id, {
            statement: "Keep storage and embedding owned centrally",
            outcomes: ["One owner backend across separated SDK execution"],
            constraints: [],
            nonGoals: [],
            assumptions: [],
            openQuestions: [],
            status: "active",
          }),
          yield* context.runtime.contextEffect,
        );
        const response = yield* Effect.provideContext(
          chat.handle(
            new Request("http://localhost/api/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Run-Id": "central-services" },
              body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                threadId: context.session.id,
                runId: "central-services",
                messages: [{ id: "m1", role: "user", content: "search memory" }],
                tools: [],
                context: [],
              }),
            }),
            context.session.id,
          ),
          yield* context.runtime.contextEffect,
        );
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.text())).toContain("central owner complete");
        const indexer = yield* Effect.provideContext(Indexer, yield* context.runtime.contextEffect);
        yield* Effect.provideContext(indexer.indexAll(), yield* context.runtime.contextEffect);
        expect(
          yield* Effect.provideContext(indexer.pending, yield* context.runtime.contextEffect),
        ).toBe(0);
        const storedVectors = db.sqlite
          .prepare("SELECT * FROM node_vectors ORDER BY node_seq")
          .all();
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
        const reopened = yield* Effect.promise(() => context.reopen());
        const restored = yield* Effect.provideContext(Database, yield* reopened.contextEffect);
        const restoredIndexer = yield* Effect.provideContext(
          Indexer,
          yield* reopened.contextEffect,
        );
        expect(
          yield* Effect.provideContext(restoredIndexer.indexAll(), yield* reopened.contextEffect),
        ).toBe(0);
        expect(embeddingCalls).toHaveLength(callsBeforeReopen);
        expect(
          restored.sqlite.prepare("SELECT * FROM node_vectors ORDER BY node_seq").all(),
        ).toEqual(storedVectors);
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
      }
    }),
  20000,
);
