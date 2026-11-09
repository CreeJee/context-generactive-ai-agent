import { Cause, Effect, Exit, HashSet, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { readOnlyToolNames } from "../tools/effects.ts";
import { ToolFailed } from "../tools/failure.ts";
import type { PreparedCall, RunTool } from "../tools/run-tool.ts";
import { failureAnnotations } from "../runtime/logged-failures.ts";

/**
 * The tool ledger of a Goal's bound run (decisions.md "Goal도 owner 프로세스에서 돌고 도구를 병렬로
 * 실행한다 (2026-10-26)"): every call is written `pending` before its tool runs and settled when it
 * ends. The rows are the Goal worker's `tool` operations in `owner_rpc_operations`, so the SQL that
 * reads them (`run-bindings.ts`, `uncertain-runs.ts`) means the same.
 * Numbers follow the order the owner reserves them in and say nothing about the order calls ran in.
 */

/** How a call that changed nothing ended: the row's `outcome`. */
const Outcome = Schema.Literals(["returned", "failed", "cancelled", "refused"]);
type Outcome = typeof Outcome.Type;

/** How a call ended, as its row keeps it: the `status` column names the case. */
const Settled = Schema.TaggedUnion({ succeeded: { outcome: Outcome }, uncertain: {} });
type Settled = typeof Settled.Type;
const outcomeOf = Settled.match({ succeeded: ({ outcome }) => outcome, uncertain: () => null });

/** A call that could not be written first does not run. */
const notRecorded = ToolFailed.make({
  code: "ledger_unavailable",
  tag: "ToolLedgerFailed",
  detail: "The call could not be recorded before it ran, so it did not run.",
});

/**
 * How a failed call that changed nothing ended: a read, which changes nothing, or a write its tool
 * refused before changing anything. None for any other write.
 */
const unchangedOutcome = (name: string, cause: Cause.Cause<ToolFailed>): Option.Option<Outcome> =>
  HashSet.has(readOnlyToolNames, name)
    ? Option.some(Cause.hasInterruptsOnly(cause) ? "cancelled" : "failed")
    : Cause.findErrorOption(cause).pipe(
        Option.filter((failed) => failed.refused === true),
        Option.as("refused"),
      );

/**
 * How a call ended, as the ledger keeps it. A call that changed nothing succeeded. Any other write
 * that failed or was cancelled may have changed something; it stays uncertain, and the run's Goal
 * waits for the user before its next run.
 */
const settledOf = <A>(name: string, exit: Exit.Exit<A, ToolFailed>) =>
  Exit.match(exit, {
    onSuccess: (): Settled => Settled.cases.succeeded.make({ outcome: "returned" }),
    onFailure: (cause): Settled =>
      Option.match(unchangedOutcome(name, cause), {
        onNone: () => Settled.cases.uncertain.make({}),
        onSome: (outcome) => Settled.cases.succeeded.make({ outcome }),
      }),
  });

export const toolLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  /** The run's binding, which every row of its ledger names. */
  const binding = SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({ run_id: Schema.String }),
    execute: (runId) => sql`SELECT run_id FROM workflow_run_bindings WHERE run_id = ${runId}`,
  });

  /** Writes the call pending under the run's next number, in one statement. */
  const reserve = SqlSchema.findOne({
    Request: Schema.Struct({
      runId: Schema.String,
      name: Schema.String,
      toolCallId: Schema.String,
    }),
    Result: Schema.Struct({ operation_id: Schema.Finite }),
    execute: ({ runId, name, toolCallId }) => sql`
      INSERT INTO owner_rpc_operations
        (run_id, operation_id, operation, tool_name, tool_call_id, side_effect, status)
      SELECT ${runId}, next.id, 'tool', ${name}, ${toolCallId}, 1, 'pending'
      FROM (SELECT coalesce(max(operation_id), 0) + 1 AS id FROM owner_rpc_operations
        WHERE run_id = ${runId}) AS next
      RETURNING operation_id`,
  });

  const settle = (runId: string, operationId: number, settled: Settled) => sql`
    UPDATE owner_rpc_operations SET status = ${settled._tag}, outcome = ${outcomeOf(settled)}
    WHERE run_id = ${runId} AND operation_id = ${operationId} AND status = 'pending'`;

  /**
   * The run's tools, each call written in the ledger before it runs. A call that could not be
   * written fails without running; one whose end could not be written stays pending, which the
   * Goal's next run asks the user about.
   */
  const forRun = (runId: string) => {
    const recorded =
      (name: string) =>
      (prepared: PreparedCall): PreparedCall =>
      (call) =>
        Effect.acquireUseRelease(
          reserve({ runId, name, toolCallId: call.toolCallId }).pipe(
            Effect.tapError((error) =>
              Effect.logError("Tool call not recorded", failureAnnotations(error)),
            ),
            Effect.mapError(() => notRecorded),
          ),
          () => prepared(call),
          ({ operation_id }, exit) =>
            settle(runId, operation_id, settledOf(name, exit)).pipe(Effect.ignore({ log: "Warn" })),
        );
    return Effect.as(binding(runId), (tools: ReadonlyArray<RunTool>) =>
      tools.map((tool): RunTool => ({
        ...tool,
        prepare: (args) => Effect.map(tool.prepare(args), recorded(tool.tool.name)),
      })),
    );
  };

  return { forRun };
});
