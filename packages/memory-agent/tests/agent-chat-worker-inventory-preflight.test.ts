import { selectTestModel } from "./support/provider.ts";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { webSearchTool } from "@tanstack/ai-openai/tools";
import { expect, vi } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import * as workerExecution from "../src/agent/full-loop-execution.ts";
import { Database } from "../src/db/database.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { testRuntime } from "./support/runtime.ts";

// Verify AgentChat uses the complete inventory preflight, not only its shared
// portability subset. Invalid inventory must not leave a reservation to recover.
it.live.each(["duplicate", "client-only", "provider-native"] as const)(
  "real worker admission rejects %s inventory before any execution evidence",
  (inventory) =>
    Effect.gen(function* () {
      vi.stubEnv("CONTEXT_AGENT_GOAL_WORKER", "1");
      try {
        const context = yield* Effect.promise(() => testRuntime({ testProvider: {} }));
        yield* Effect.provideContext(selectTestModel(), yield* context.runtime.contextEffect);
        const { chat, db, workflows } = yield* Effect.provideContext(
          Effect.all({ chat: AgentChat, db: Database, workflows: Workflows }),
          yield* context.runtime.contextEffect,
        );
        yield* Effect.provideContext(
          workflows.updateGoal(context.session.id, {
            statement: "Reject unsupported inventory before admission",
            outcomes: ["No phantom run or uncertain side effect"],
            constraints: [],
            nonGoals: [],
            assumptions: [],
            openQuestions: [],
            status: "active",
          }),
          yield* context.runtime.contextEffect,
        );
        const validate = workerExecution.preflightFullLoopExecution;
        const preflight = vi
          .spyOn(workerExecution, "preflightFullLoopExecution")
          .mockImplementation((turn, capabilities) => {
            const first = capabilities.tools[0]!;
            expect(first).toBeDefined();
            const extra =
              inventory === "duplicate"
                ? first
                : inventory === "provider-native"
                  ? webSearchTool({ type: "web_search" })
                  : { ...first, name: "test-client-only", execute: undefined };
            const invalidCapabilities = { ...capabilities };
            const invalidTools = [...capabilities.tools, extra];
            // Deliberately cross the runtime admission boundary without asserting
            // that the native/client fixture satisfies the server-tool contract.
            expect(Reflect.set(invalidCapabilities, "tools", invalidTools)).toBe(true);
            expect(invalidCapabilities.tools).toBe(invalidTools);
            expect(invalidTools.at(-1)).toBe(extra);
            validate(turn, invalidCapabilities);
          });
        const request = new Request("http://localhost/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            threadId: context.session.id,
            runId: `unsupported-${inventory}`,
            messages: [{ id: "m1", role: "user", content: "hello" }],
            tools: [],
            context: [],
          }),
        });
        const response = yield* Effect.provideContext(
          chat.handle(request, context.session.id),
          yield* context.runtime.contextEffect,
        );
        expect(response.status).toBe(409);
        expect(yield* Effect.promise(() => response.json())).toMatchObject({
          error: "unsupported_worker_capabilities",
          detail: expect.stringMatching(/^Unsupported owner tool grant capability: /),
        });
        expect(preflight).toHaveBeenCalledTimes(1);
        for (const table of [
          "workflow_run_bindings",
          "workflow_worker_dispatches",
          "workflow_run_events",
          "owner_rpc_operations",
          "chat_runs",
          "nodes",
        ])
          expect(db.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
        expect(context.provider!.adapter.invocations).toHaveLength(0);
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
    }),
);
