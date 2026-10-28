import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { invocationFieldSql } from "../../src/workflow/run-bindings.ts";
import { conversation } from "../golden/driver.ts";
import { goldenAgent } from "../golden/scenarios.ts";
import { sqlAll } from "../support/sql.ts";
import { TestEnv } from "../support/test-env.ts";

/**
 * The calls of a Goal run's step run at once, each kept in the ledger on its own
 * (docs/effect-ai-migration.md step 5). A call that ends after the others does not fail the run,
 * and a refused write leaves the other results recorded for the model's next step. Which call ends
 * last is timing, which no type checks.
 */

/** The call id the scripted model wrote, without the conversation it carries. */
const scripted = (id: string) => id.replace(/@.*$/, "");

goldenAgent()("parallel tools in a Goal run", (it) => {
  it.effect(
    "records every call of the step and shows all results to the next step",
    () =>
      Effect.gen(function* () {
        const chat = yield* conversation("full");
        yield* chat.goal;
        yield* chat.send("golden:goal-parallel");

        expect(
          yield* sqlAll("SELECT status FROM chat_runs WHERE thread_id = ?", chat.sessionId),
        ).toEqual([{ status: "completed" }]);
        const ledger = yield* sqlAll(
          `SELECT ${invocationFieldSql("o", "toolCallId")} AS call,
             o.status || ' ' || json_extract(o.reply_json, '$.output') AS outcome
           FROM owner_rpc_operations o JOIN workflow_run_bindings b ON b.run_id = o.run_id
           WHERE b.session_id = ?`,
          chat.sessionId,
        );
        // The refused write changed nothing, so it does not leave the run's outcome unknown.
        expect(
          Object.fromEntries(ledger.map((row) => [scripted(String(row["call"])), row["outcome"]])),
        ).toEqual({
          "goal-slow": "succeeded returned",
          "goal-slow-run": "succeeded returned",
          "goal-stale": "succeeded refused",
          "goal-new": "succeeded returned",
        });

        const { provider } = yield* TestEnv;
        const last = provider?.invocations
          .filter((invocation) => invocation.run.threadId === chat.sessionId)
          .at(-1);
        const results = (last?.history ?? []).flatMap((message) =>
          message.role === "tool"
            ? [{ call: scripted(message.toolCallId), content: JSON.stringify(message.content) }]
            : [],
        );
        expect(results.slice(-3).map(({ call }) => call)).toEqual([
          "goal-slow-run",
          "goal-stale",
          "goal-new",
        ]);
        expect(results.at(-3)?.content).toContain("slow");
      }),
    20_000,
  );
});
