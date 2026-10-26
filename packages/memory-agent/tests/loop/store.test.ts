import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vite-plus/test";
import { connectionContext } from "../../src/db/database.ts";
import { migrations } from "../../src/db/migrations.ts";
import { InterruptAnswer, RunStore } from "../../src/loop/store.ts";

/**
 * An interrupt batch commits whole or not at all (docs/effect-ai-migration.md "보안 체크리스트",
 * interrupt 재개 handshake): a duplicate, missing or already answered interrupt refuses the batch.
 */

const database = Effect.acquireRelease(
  Effect.sync(() => {
    const sqlite = new DatabaseSync(":memory:");
    for (const migration of migrations) sqlite.exec(migration);
    return sqlite;
  }),
  (sqlite) => Effect.sync(() => sqlite.close()),
);

const approval = (id: string) => ({
  id,
  reason: "tool_call" as const,
  message: "Approval required to run write_file",
  toolCallId: id,
  responseSchema: {},
  metadata: { kind: "approval" as const, toolName: "write_file", input: {} },
});

const statuses = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql`SELECT interrupt_id, status FROM chat_interrupts ORDER BY seq`.pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ interrupt_id: Schema.String, status: Schema.String })),
      ),
    ),
  ),
);

const resolved = (interruptId: string) =>
  InterruptAnswer.Resolved({ interruptId, response: { approved: true } });

it.effect("refuses an interrupt batch that is not all pending, and writes none of it", () =>
  Effect.gen(function* () {
    const sql = yield* connectionContext(yield* database);
    const services = Context.merge(
      sql,
      yield* Effect.provideContext(Layer.build(RunStore.layer), sql),
    );
    yield* Effect.gen(function* () {
      const store = yield* RunStore;
      yield* store.createInterrupts({ runId: "run", threadId: "thread" }, [
        approval("a"),
        approval("b"),
      ]);
      const refusal = (answers: ReadonlyArray<InterruptAnswer>) =>
        store.commitInterrupts(answers).pipe(
          Effect.andThen(Effect.die("the batch was committed")),
          Effect.catchTag("InterruptCommitRejected", ({ reason, interruptId }) =>
            Effect.succeed([reason, interruptId]),
          ),
        );

      expect(yield* refusal([resolved("a"), resolved("a")])).toEqual(["duplicate-interrupt", "a"]);
      expect(yield* refusal([resolved("a"), resolved("missing")])).toEqual([
        "missing-interrupt",
        "missing",
      ]);
      yield* store.commitInterrupts([InterruptAnswer.Cancelled({ interruptId: "b" })]);
      expect(yield* refusal([resolved("a"), resolved("b")])).toEqual([
        "interrupt-not-pending",
        "b",
      ]);
      expect(yield* statuses).toEqual([
        { interrupt_id: "a", status: "pending" },
        { interrupt_id: "b", status: "cancelled" },
      ]);
    }).pipe(Effect.provideContext(services));
  }).pipe(Effect.scoped),
);
