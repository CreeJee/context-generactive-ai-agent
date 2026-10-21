import { SqlClient } from "effect/sql";
import { Effect, Exit, Schema } from "effect";
import { expect } from "vite-plus/test";
import { AgentChat } from "../../src/agent/chat.ts";
import { encodeFullLoopValue } from "../../src/agent/full-loop-codec.ts";
import { makeOwnerNativeArtifacts } from "../../src/agent/owner-native-artifacts.ts";
import {
  OwnerReadRecovery,
  ReadRecoveryConfirmResult,
  ReadRecoveryPreview,
  ReadRecoveryRevokeResult,
} from "../../src/agent/owner-read-recovery.ts";
import { migrateOwnerRpcFingerprintBatch } from "../../src/agent/owner-rpc-fingerprint-migration.ts";
import { makeSqliteOwnerRpcLedger } from "../../src/agent/owner-rpc-ledger.ts";
import { OwnerRpcAdmission, OwnerRpcReply } from "../../src/agent/owner-rpc.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { GoalExecutions } from "../../src/workflow/goal-execution.ts";
import { OwnerWorkflowAdmissionResult } from "../../src/workflow/owner-workflow-storage.ts";
import {
  GoalExecutionErrorReason,
  GoalExecutionPayload,
} from "../../src/workflow/goal-execution-contracts.ts";
import { workflowRunBindings } from "../../src/workflow/run-bindings.ts";
import { Workflows } from "../../src/workflow/workflow.ts";
import { selectTestModel } from "../support/provider.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import { sqlAll, sqlGet, sqlRun } from "../support/sql.ts";

const toJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const goal = {
  statement: "Continue only after a verified read failure",
  outcomes: ["Retain original failure"],
  constraints: [],
  nonGoals: [],
  assumptions: [],
  openQuestions: [],
  status: "active" as const,
};
const backgroundRead = {
  name: "get_background_result",
  args: { taskId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", offset: 0 },
};
const refused = { status: "refused", reason: "run_outcome_uncertain" };

/**
 * A fresh session whose Goal run failed after an authorized read left its only tool call
 * uncertain: the state an operator may explicitly recover. Run IDs are global, so they carry the
 * session.
 */
const failedRead = Effect.fnUntraced(function* (
  readCall: { readonly name: string; readonly args: Schema.Json } = backgroundRead,
) {
  const env = yield* TestEnv;
  const workflows = yield* Workflows;
  const executions = yield* GoalExecutions;
  const session = (yield* (yield* Sessions).create(env.project.id)).id;
  const runId = `${session}:failed-read`;
  yield* workflows.updateGoal(session, goal);
  const revision = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ id: Schema.Finite, goal_instance_id: Schema.String }),
  )(
    yield* sqlGet(
      "SELECT id,goal_instance_id FROM workflow_state_revisions WHERE session_id=? ORDER BY id DESC LIMIT 1",
      session,
    ),
  );
  const owner = yield* workflowRunBindings;
  const artifacts = yield* makeOwnerNativeArtifacts({
    directory: `${env.storage}/native-artifacts`,
  });
  yield* Effect.scoped(artifacts.acquire(revision.goal_instance_id));
  const payload = GoalExecutionPayload.make({
    identity: {
      owner: { ownerId: env.project.id, generation: "fixture-owner" },
      sessionId: session,
      runId,
      goalInstanceId: revision.goal_instance_id,
      workflowRevisionId: revision.id,
    },
  });
  const admitted = yield* executions.admitAndStart(
    payload,
    owner.bind(session, runId, revision.id),
  );
  if (!OwnerWorkflowAdmissionResult.$is("admitted")(admitted))
    return yield* Effect.die("new admission expected");
  const key = yield* toJson(admitted.value);
  yield* sqlRun(
    "INSERT INTO chat_runs(run_id,thread_id,status,started_at,finished_at,error_code) VALUES(?,?,'failed',1,2,'worker_execution_failed')",
    runId,
    session,
  );
  const ledger = yield* makeSqliteOwnerRpcLedger;
  const call = { ...readCall, toolCallId: "read-call" };
  const fingerprint = (operation: string) =>
    JSON.stringify({ operation, input: encodeFullLoopValue(call) });
  expect(yield* ledger.reserve(key, 1, fingerprint("toolAuthorize"), true)).toEqual(
    OwnerRpcAdmission.reserved(),
  );
  yield* ledger.settle(key, 1, OwnerRpcReply.succeeded({ operationId: 1, output: null }));
  expect(yield* ledger.reserve(key, 2, fingerprint("tool"), true)).toEqual(
    OwnerRpcAdmission.reserved(),
  );
  yield* ledger.settle(key, 2, OwnerRpcReply.uncertain({ operationId: 2 }));
  yield* executions.fail(
    payload,
    GoalExecutionErrorReason.cases.SideEffectUncertain.make({
      operationId: "2",
      state: "uncertain",
    }),
  );
  const recovery = yield* OwnerReadRecovery;
  const preview = yield* recovery.assess(session, runId);
  expect(ReadRecoveryPreview.$is("eligible")(preview)).toBe(true);
  if (!ReadRecoveryPreview.$is("eligible")(preview))
    return yield* Effect.die("eligible fixture expected");
  const tables = [
    "chat_runs",
    "owner_rpc_operations",
    "workflow_run_bindings",
    "owner_workflow_executions",
    "owner_workflow_deferreds",
    "workflow_state_revisions",
  ];
  return {
    session,
    runId,
    owner,
    revision,
    key,
    ledger,
    recovery,
    confirmation: {
      assessmentId: preview.assessmentId,
      confirmation: "confirm_read_only_and_continue_without_replay" as const,
      backup: {
        reference: "isolated-fixture-backup",
        verification: "operator_verified_original_records" as const,
      },
    },
    /** Every historical row recovery must leave untouched. */
    history: Effect.forEach(tables, (table) => sqlAll(`SELECT * FROM ${table}`)),
    /** Durable receipts for this run. */
    receipts: sqlGet("SELECT count(*) AS n FROM owner_read_recoveries WHERE run_id=?", runId),
    /** Model calls made for this session. */
    modelCalls: () =>
      env.provider!.adapter.invocations.filter((invocation) => invocation.threadId === session),
    /** Rewrite one owner RPC row of this run. */
    updateOperation: (operationId: number, assignment: string, ...values: string[]) =>
      sqlRun(
        `UPDATE owner_rpc_operations SET ${assignment} WHERE run_id=? AND operation_id=?`,
        ...values,
        runId,
        operationId,
      ),
  };
});

testAgent({ testProvider: {} })("explicit owner read recovery", (it) => {
  it.effect.each(["get_subagent_report", "get_subagent_reports"] as const)(
    "explicit report-read recovery preserves originals and refuses mismatched authorization (%s)",
    (name) =>
      Effect.gen(function* () {
        const attempt = {
          taskId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          attemptId: "11111111-2222-4333-8444-555555555555",
        };
        const changedAttempt = { ...attempt, attemptId: "66666666-7777-4888-8999-000000000000" };
        let args: Schema.Json;
        let changedArgs: Schema.Json;
        switch (name) {
          case "get_subagent_report":
            args = attempt;
            changedArgs = changedAttempt;
            break;
          case "get_subagent_reports":
            args = { attempts: [attempt] };
            changedArgs = { attempts: [changedAttempt] };
            break;
        }
        const f = yield* failedRead({ name, args });
        const before = yield* f.history;
        expect(
          ReadRecoveryConfirmResult.$is("recovered")(
            yield* f.recovery.confirm(f.session, f.runId, f.confirmation),
          ),
        ).toBe(true);
        expect(yield* f.history).toEqual(before);
        expect(
          (yield* f.owner.preview(f.session, `${f.session}:next-report`, f.revision.id)).status,
        ).toBe("bound");
        yield* f.updateOperation(
          1,
          "fingerprint=?",
          yield* toJson({
            operation: "toolAuthorize",
            input: encodeFullLoopValue({ name, toolCallId: "read-call", args: changedArgs }),
          }),
        );
        expect(
          yield* f.owner.preview(f.session, `${f.session}:changed-report`, f.revision.id),
        ).toEqual(refused);
      }),
    20000,
  );

  it.effect.each([
    "write_tool",
    "pending",
    "later_operation",
    "missing_authorization",
    "authorization_key_mismatch",
    "other_uncertain",
    "active_task",
    "wrong_goal",
    "wrong_failure",
    "wrong_session",
    "stale_preview",
  ] as const)(
    "recovery refuses %s without changing historical rows or issuing an effect",
    (reason) =>
      Effect.gen(function* () {
        const f = yield* failedRead();
        let session = f.session;
        switch (reason) {
          case "write_tool":
            yield* f.updateOperation(
              2,
              "fingerprint=?",
              yield* toJson({
                operation: "tool",
                input: encodeFullLoopValue({ name: "shell", args: {}, toolCallId: "read-call" }),
              }),
            );
            break;
          case "pending":
            yield* f.updateOperation(2, "status='pending'");
            break;
          case "later_operation":
            yield* sqlRun(
              "INSERT INTO owner_rpc_operations SELECT run_id,run_key,3,'{}',0,'{}','succeeded' FROM owner_rpc_operations WHERE run_id=? AND operation_id=2",
              f.runId,
            );
            break;
          case "missing_authorization":
            yield* f.updateOperation(1, "fingerprint='{}'");
            break;
          case "authorization_key_mismatch":
            yield* f.updateOperation(1, "run_key='{}'");
            break;
          case "other_uncertain":
            yield* f.updateOperation(1, "status='uncertain'");
            break;
          case "active_task":
            yield* sqlRun(
              "INSERT INTO work_tasks(id,project_id,origin_session_id,parent_run_id,parent_tool_call_id,agent_name,status,title,request,created_at,updated_at) VALUES(?,?,?,?,'read-call','background_shell','running','','',1,1)",
              `${f.session}:active`,
              (yield* TestEnv).project.id,
              f.session,
              f.runId,
            );
            break;
          case "wrong_goal":
          case "stale_preview":
            yield* (yield* Workflows).updateGoal(f.session, {
              ...goal,
              statement: "Changed revision",
              outcomes: [],
            });
            if (reason === "wrong_goal") yield* f.updateOperation(2, "run_key='{}'");
            break;
          case "wrong_failure":
            yield* sqlRun(
              "UPDATE owner_workflow_executions SET result_json='{}' WHERE instr(payload_json, ?) > 0",
              f.runId,
            );
            break;
          case "wrong_session":
            session = `${f.session}:other`;
            break;
        }
        const before = yield* f.history;
        expect(
          ReadRecoveryConfirmResult.$is("blocked")(
            yield* f.recovery.confirm(session, f.runId, f.confirmation),
          ),
        ).toBe(true);
        expect(yield* f.history).toEqual(before);
        expect(yield* f.receipts).toEqual({ n: 0 });
        expect(f.modelCalls()).toHaveLength(0);
      }),
  );

  it.effect.each(["failed", "blocked"] as const)(
    "historical %s task with no live attempt does not block the target read recovery",
    (status) =>
      Effect.gen(function* () {
        const f = yield* failedRead();
        const task = `${f.session}:historical`;
        yield* sqlRun(
          "INSERT INTO work_tasks(id,project_id,origin_session_id,parent_run_id,parent_tool_call_id,agent_name,status,title,request,created_at,updated_at) VALUES(?,?,?,'older-run','old-call','background_shell',?,'','',1,1)",
          task,
          (yield* TestEnv).project.id,
          f.session,
          status,
        );
        expect(
          ReadRecoveryPreview.$is("eligible")(yield* f.recovery.assess(f.session, f.runId)),
        ).toBe(true);
        expect(
          yield* sqlGet("SELECT status,active_attempt_id FROM work_tasks WHERE id=?", task),
        ).toEqual({ status, active_attempt_id: null });
      }),
  );

  it.effect(
    "operator revocation restores admission blocking without changing the original failure or deleting the receipt",
    () =>
      Effect.gen(function* () {
        const f = yield* failedRead();
        const before = yield* f.history;
        const receipt = yield* f.recovery.confirm(f.session, f.runId, f.confirmation);
        if (!ReadRecoveryConfirmResult.$is("recovered")(receipt))
          return yield* Effect.die("recovery expected");
        const input = {
          confirmation: "revoke_read_recovery_without_replay" as const,
          receiptId: receipt.receiptId,
        };
        const result = yield* f.recovery.revoke(f.session, f.runId, input);
        expect(ReadRecoveryRevokeResult.$is("revoked")(result)).toBe(true);
        expect(yield* f.recovery.revoke(f.session, f.runId, input)).toEqual(result);
        expect(yield* f.history).toEqual(before);
        expect(yield* f.owner.bind(f.session, `${f.session}:new-run`, f.revision.id)).toEqual(
          refused,
        );
        expect(yield* f.receipts).toEqual({ n: 1 });
        expect(f.modelCalls()).toHaveLength(0);
      }),
  );

  it.effect(
    "actual AgentChat allows only a fresh explicit request after recovery and rejects the original run",
    () =>
      Effect.gen(function* () {
        const f = yield* failedRead();
        const chat = yield* AgentChat;
        yield* selectTestModel();
        const send = (runId: string) =>
          chat.handle(
            new Request("http://localhost/api/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                threadId: f.session,
                runId,
                messages: [
                  {
                    id: `${runId}:user`,
                    role: "user",
                    content: "Inspect existing results before continuing",
                  },
                ],
                tools: [],
                context: [],
              }),
            }),
            f.session,
          );
        const freshRun = `${f.session}:new-run`;
        expect((yield* send(freshRun)).status).toBe(409);
        const confirmation = yield* chat.confirmReadRecovery(
          f.session,
          null,
          f.runId,
          f.confirmation,
        );
        expect(confirmation.status).toBe(200);
        expect(f.modelCalls()).toHaveLength(0);
        expect((yield* send(f.runId)).status).toBe(409);
        const response = yield* send(freshRun);
        const body = yield* Effect.promise(() => response.text());
        expect(response.status, body).toBe(200);
        expect(body).not.toContain("worker_execution_failed");
        expect(f.modelCalls().length).toBeGreaterThan(0);
        expect(
          yield* sqlGet("SELECT status,error_code FROM chat_runs WHERE run_id=?", f.runId),
        ).toEqual({ status: "failed", error_code: "worker_execution_failed" });
      }),
    20000,
  );
});

// Maintenance and an outer transaction span the whole database, so they get their own agent.
testAgent({ testProvider: {} })("owner read recovery across the database", (it) => {
  it.effect("fingerprint maintenance preserves immutable receipt-linked request originals", () =>
    Effect.gen(function* () {
      const f = yield* failedRead();
      expect(
        ReadRecoveryConfirmResult.$is("recovered")(
          yield* f.recovery.confirm(f.session, f.runId, f.confirmation),
        ),
      ).toBe(true);
      const before = yield* f.history;
      expect(yield* migrateOwnerRpcFingerprintBatch(0, 4)).toMatchObject({
        migrated: 0,
        retained: 2,
        done: true,
      });
      expect(yield* f.history).toEqual(before);
      expect(
        ReadRecoveryPreview.$is("recovered")(yield* f.recovery.assess(f.session, f.runId)),
      ).toBe(true);
      expect((yield* f.owner.preview(f.session, `${f.session}:fresh`, f.revision.id)).status).toBe(
        "bound",
      );
    }),
  );

  it.effect("recovery cannot issue a durable receipt inside an outer transaction", () =>
    Effect.gen(function* () {
      const f = yield* failedRead();
      const sql = yield* SqlClient.SqlClient;
      const result = yield* Effect.exit(
        sql.withTransaction(f.recovery.confirm(f.session, f.runId, f.confirmation)),
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(yield* f.receipts).toEqual({ n: 0 });
    }),
  );
});

// Reopening replaces the agent, so this test reads services through `env.use` afterwards.
testAgent({ testProvider: {} })("owner read recovery across reopen", (it) => {
  it.effect(
    "explicit recovery preserves failure, is immutable/idempotent and permits a new binding after reopen",
    () =>
      Effect.gen(function* () {
        const env = yield* TestEnv;
        const f = yield* failedRead();
        const next = `${f.session}:next`;
        const before = yield* f.history;
        expect(yield* f.owner.preview(f.session, `${f.session}:probe`, f.revision.id)).toEqual(
          refused,
        );
        expect(yield* f.owner.bind(f.session, next, f.revision.id)).toEqual(refused);
        const result = yield* f.recovery.confirm(f.session, f.runId, f.confirmation);
        expect(ReadRecoveryConfirmResult.$is("recovered")(result)).toBe(true);
        expect(yield* f.history).toEqual(before);
        expect(
          (yield* f.owner.preview(f.session, `${f.session}:probe`, f.revision.id)).status,
        ).toBe("bound");
        expect(yield* f.history).toEqual(before);
        expect(yield* f.recovery.confirm(f.session, f.runId, f.confirmation)).toEqual(result);
        expect(yield* f.receipts).toEqual({ n: 1 });
        expect(
          String(
            (yield* Effect.flip(
              sqlRun(
                "UPDATE owner_read_recoveries SET policy='background-result-read-v1' WHERE run_id=?",
                f.runId,
              ),
            )).reason.cause,
          ),
        ).toContain("immutable");
        expect(
          String(
            (yield* Effect.flip(
              sqlRun("DELETE FROM owner_read_recoveries WHERE run_id=?", f.runId),
            )).reason.cause,
          ),
        ).toContain("retained");
        expect(
          OwnerRpcAdmission.$is("existing")(yield* f.ledger.reserve(f.key, 2, "different", true)),
        ).toBe(true);
        for (const [fingerprint, sideEffect] of [
          ["new-read", false],
          ["new-write", true],
        ] as const)
          expect(yield* f.ledger.reserve(f.key, 3, fingerprint, sideEffect)).toEqual(
            OwnerRpcAdmission.rejected({ reason: "uncertain_run" }),
          );
        const authorization = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ fingerprint: Schema.String }),
        )(
          yield* sqlGet(
            "SELECT fingerprint FROM owner_rpc_operations WHERE run_id=? AND operation_id=1",
            f.runId,
          ),
        );
        yield* f.updateOperation(1, "fingerprint='{}'");
        expect(
          ReadRecoveryPreview.$is("blocked")(yield* f.recovery.assess(f.session, f.runId)),
        ).toBe(true);
        expect(yield* f.owner.bind(f.session, next, f.revision.id)).toEqual(refused);
        yield* f.updateOperation(1, "fingerprint=?", authorization.fingerprint);
        expect(yield* f.history).toEqual(before);
        yield* env.reopen;
        expect(
          ReadRecoveryPreview.$is("recovered")(
            yield* (yield* env.use(OwnerReadRecovery)).assess(f.session, f.runId),
          ),
        ).toBe(true);
        const reopened = Effect.provideService(
          SqlClient.SqlClient,
          yield* env.use(SqlClient.SqlClient),
        );
        const bindings = yield* reopened(workflowRunBindings);
        const binding = yield* bindings.bind(f.session, next, f.revision.id);
        expect(binding.status).toBe("bound");
        if (binding.status !== "bound") return yield* Effect.die("new binding expected");
        const ledger = yield* reopened(makeSqliteOwnerRpcLedger);
        expect(
          yield* ledger.reserve(yield* toJson(binding.binding), 1, "new-effect", true),
        ).toEqual(OwnerRpcAdmission.reserved());
        expect(yield* bindings.bind(f.session, f.runId, f.revision.id)).toEqual({
          status: "refused",
          reason: "run_id_conflict",
        });
      }),
  );
});
