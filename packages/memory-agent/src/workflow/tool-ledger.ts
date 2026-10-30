import { Cause, Effect, Exit, HashSet, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import {
  ownerRpcCanonicalJson,
  ownerRpcFingerprint,
  ownerRpcFrame,
} from "../agent/owner-rpc-fingerprint.ts";
import { JsonValue } from "../json.ts";
import { readOnlyToolNames } from "../tools/effects.ts";
import { ToolFailed } from "../tools/failure.ts";
import type { PreparedCall, RunTool } from "../tools/run-tool.ts";
import { failureAnnotations } from "../runtime/logged-failures.ts";

/**
 * The tool ledger of a Goal's bound run (decisions.md "Goal도 owner 프로세스에서 돌고 도구를 병렬로
 * 실행한다 (2026-10-26)"): every call is written `pending` before its tool runs and settled when it
 * ends. The rows are the Goal worker's `tool` operations in `owner_rpc_operations`, so the SQL that
 * reads them (`run-bindings.ts`, `uncertain-runs.ts`, `completion-evidence.ts`) means the same.
 * Numbers follow the order the owner reserves them in and say nothing about the order calls ran in.
 */

const Binding = Schema.Struct({
  session_id: Schema.String,
  goal_instance_id: Schema.String,
  goal_version: Schema.Finite,
  plan_version: Schema.NullOr(Schema.Finite),
  workflow_revision_id: Schema.Finite,
});

/** A settled row's reply, as the Goal worker's ledger wrote it. */
const Settled = Schema.TaggedUnion({
  succeeded: { operationId: Schema.Finite, output: JsonValue },
  uncertain: { operationId: Schema.Finite },
});
type Settled = typeof Settled.Type;
const encodeSettled = Schema.encodeEffect(Schema.fromJsonString(Settled));
/** The `status` column names the reply's case. */
const statusOf = Settled.match({ succeeded: () => "succeeded", uncertain: () => "uncertain" });

/** The fingerprint of a call: `uncertainRuns` shows its tool name and arguments to the user. */
const fingerprintOf = (name: string, args: JsonValue, toolCallId: string) =>
  Effect.try(() => ownerRpcFingerprint("tool", ownerRpcFrame({ name, args, toolCallId })));

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
const unchangedOutput = (name: string, cause: Cause.Cause<ToolFailed>): Option.Option<string> =>
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
const settledOf = (name: string, operationId: number, exit: Exit.Exit<JsonValue, ToolFailed>) =>
  Exit.match(exit, {
    onSuccess: (): Settled => Settled.cases.succeeded.make({ operationId, output: "returned" }),
    onFailure: (cause): Settled =>
      Option.match(unchangedOutput(name, cause), {
        onNone: () => Settled.cases.uncertain.make({ operationId }),
        onSome: (output) => Settled.cases.succeeded.make({ operationId, output }),
      }),
  });

export const toolLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const binding = SqlSchema.findOne({
    Request: Schema.String,
    Result: Binding,
    execute: (runId) => sql`
      SELECT session_id, goal_instance_id, goal_version, plan_version, workflow_revision_id
      FROM workflow_run_bindings WHERE run_id = ${runId}`,
  });

  /** Writes the call pending under the run's next number, in one statement. */
  const reserve = SqlSchema.findOne({
    Request: Schema.Struct({
      runId: Schema.String,
      runKey: Schema.String,
      fingerprint: Schema.String,
    }),
    Result: Schema.Struct({ operation_id: Schema.Finite }),
    execute: ({ runId, runKey, fingerprint }) => sql`
      INSERT INTO owner_rpc_operations
        (run_id, run_key, operation_id, fingerprint, side_effect, reply_json, status)
      SELECT ${runId}, ${runKey}, next.id, ${fingerprint}, 1,
        json_object('_tag', 'pending', 'operationId', next.id), 'pending'
      FROM (SELECT coalesce(max(operation_id), 0) + 1 AS id FROM owner_rpc_operations
        WHERE run_id = ${runId}) AS next
      RETURNING operation_id`,
  });

  const settle = (runId: string, settled: Settled) =>
    Effect.flatMap(
      encodeSettled(settled),
      (reply) => sql`
        UPDATE owner_rpc_operations SET reply_json = ${reply}, status = ${statusOf(settled)}
        WHERE run_id = ${runId} AND operation_id = ${settled.operationId} AND status = 'pending'`,
    );

  /**
   * The run's tools, each call written in the ledger before it runs. A call that could not be
   * written fails without running; one whose end could not be written stays pending, which the
   * Goal's next run asks the user about.
   */
  const forRun = (runId: string) =>
    Effect.map(binding(runId), (bound) => {
      const runKey = ownerRpcCanonicalJson({
        sessionId: bound.session_id,
        runId,
        goalInstanceId: bound.goal_instance_id,
        goalVersion: bound.goal_version,
        planVersion: bound.plan_version,
        workflowRevisionId: bound.workflow_revision_id,
      });
      const recorded =
        (name: string, args: JsonValue) =>
        (prepared: PreparedCall): PreparedCall =>
        (call) =>
          Effect.acquireUseRelease(
            fingerprintOf(name, args, call.toolCallId).pipe(
              Effect.flatMap((fingerprint) => reserve({ runId, runKey, fingerprint })),
              Effect.tapError((error) =>
                Effect.logError("Tool call not recorded", failureAnnotations(error)),
              ),
              Effect.mapError(() => notRecorded),
            ),
            () => prepared(call),
            ({ operation_id }, exit) =>
              settle(runId, settledOf(name, operation_id, exit)).pipe(
                Effect.ignore({ log: "Warn" }),
              ),
          );
      return (tools: ReadonlyArray<RunTool>) =>
        tools.map((tool): RunTool => ({
          ...tool,
          prepare: (args) => Effect.map(tool.prepare(args), recorded(tool.tool.name, args)),
        }));
    });

  return { forRun };
});
