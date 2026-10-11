import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { GoalExecutions } from "../src/workflow/goal-execution.ts";
import { workflowRunBindings } from "../src/workflow/run-bindings.ts";
import { makeSqliteOwnerRpcLedger } from "../src/agent/owner-rpc-ledger.ts";
import { makeOwnerNativeArtifacts } from "../src/agent/owner-native-artifacts.ts";
import { makeOwnerReadRecovery } from "../src/agent/owner-read-recovery.ts";
import { encodeFullLoopValue } from "../src/agent/full-loop-codec.ts";
import { AgentChat } from "../src/agent/chat.ts";
import { selectTestModel } from "./support/provider.ts";
import { testRuntime } from "./support/runtime.ts";
import { migrateOwnerRpcFingerprintBatch } from "../src/agent/owner-rpc-fingerprint-migration.ts";

const fixture = Effect.fn("readRecovery.fixture")(function* (
  readCall: { readonly name: string; readonly args: Schema.Json } = {
    name: "get_background_result",
    args: { taskId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", offset: 0 },
  },
) {
  const context = yield* Effect.promise(() => testRuntime({ testProvider: {} }));
  const services = yield* context.runtime.contextEffect;
  const { db, workflows, executions, chat } = yield* Effect.provideContext(
    Effect.all({
      db: Database,
      workflows: Workflows,
      executions: GoalExecutions,
      chat: AgentChat,
    }),
    services,
  );
  yield* Effect.provideContext(
    workflows.updateGoal(context.session.id, {
      statement: "Continue only after a verified read failure",
      outcomes: ["Retain original failure"],
      constraints: [],
      nonGoals: [],
      assumptions: [],
      openQuestions: [],
      status: "active",
    }),
    services,
  );
  const revision = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ id: Schema.Finite, goal_instance_id: Schema.String }),
  )(
    db.sqlite
      .prepare(
        "SELECT id,goal_instance_id FROM workflow_state_revisions WHERE session_id=? ORDER BY id DESC LIMIT 1",
      )
      .get(context.session.id),
  );
  const owner = workflowRunBindings(db);
  yield* Effect.scoped(
    makeOwnerNativeArtifacts({ ...db, directory: `${context.storage}/native-artifacts` }).acquire(
      revision.goal_instance_id,
    ),
  );
  const payload = {
    _tag: "GoalExecutionPayload" as const,
    identity: {
      owner: { ownerId: context.project.id, generation: "fixture-owner" },
      sessionId: context.session.id,
      runId: "failed-read",
      goalInstanceId: revision.goal_instance_id,
      workflowRevisionId: revision.id,
    },
  };
  const admitted = yield* Effect.provideContext(
    executions.admitAndStart(payload, () =>
      owner.bind(context.session.id, "failed-read", revision.id),
    ),
    services,
  );
  if (admitted.type !== "admitted") return yield* Effect.die("new admission expected");
  const binding = admitted.value;
  const key = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(binding);
  db.sqlite
    .prepare(
      "INSERT INTO chat_runs(run_id,thread_id,status,started_at,finished_at,error_code) VALUES(?,?,'failed',1,2,'worker_execution_failed')",
    )
    .run("failed-read", context.session.id);
  const ledger = makeSqliteOwnerRpcLedger(db);
  const call = {
    ...readCall,
    toolCallId: "read-call",
  };
  const fingerprint = (operation: string) =>
    JSON.stringify({ operation, input: encodeFullLoopValue(call) });
  expect(ledger.reserve(key, 1, fingerprint("toolAuthorize"), true)).toEqual({ type: "reserved" });
  ledger.settle(key, 1, { type: "succeeded", operationId: 1, output: null });
  expect(ledger.reserve(key, 2, fingerprint("tool"), true)).toEqual({ type: "reserved" });
  ledger.settle(key, 2, { type: "uncertain", operationId: 2 });
  yield* Effect.provideContext(
    executions.fail(payload, { _tag: "SideEffectUncertain", operationId: "2", state: "uncertain" }),
    services,
  );
  const recovery = makeOwnerReadRecovery(db);
  const preview = yield* recovery.assess(context.session.id, "failed-read");
  expect(preview.type).toBe("eligible");
  if (preview.type !== "eligible") return yield* Effect.die("eligible fixture expected");
  const confirmation = {
    assessmentId: preview.assessmentId,
    confirmation: "confirm_read_only_and_continue_without_replay" as const,
    backup: {
      reference: "isolated-fixture-backup",
      verification: "operator_verified_original_records" as const,
    },
  };
  const tables = [
    "chat_runs",
    "owner_rpc_operations",
    "workflow_run_bindings",
    "owner_workflow_executions",
    "owner_workflow_deferreds",
    "workflow_state_revisions",
  ];
  const history = () => tables.map((table) => db.sqlite.prepare(`SELECT * FROM ${table}`).all());
  return {
    context,
    services,
    db,
    workflows,
    owner,
    revision,
    key,
    ledger,
    recovery,
    confirmation,
    chat,
    history,
  };
});

it.live("fingerprint maintenance preserves immutable receipt-linked request originals", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    expect(
      (yield* f.recovery.confirm(f.context.session.id, "failed-read", f.confirmation)).type,
    ).toBe("recovered");
    const before = f.history();
    const result = yield* migrateOwnerRpcFingerprintBatch(f.db, 0, 4);
    expect(result).toMatchObject({ migrated: 0, retained: 2, done: true });
    expect(f.history()).toEqual(before);
    expect((yield* f.recovery.assess(f.context.session.id, "failed-read")).type).toBe("recovered");
    expect(
      f.owner.preview(f.context.session.id, "fresh-after-maintenance", f.revision.id).status,
    ).toBe("bound");
  }),
);

it.live.each(["get_subagent_report", "get_subagent_reports"])(
  "explicit report-read recovery preserves originals and refuses mismatched authorization (%s)",
  (name) =>
    Effect.gen(function* () {
      const attempt = {
        taskId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        attemptId: "11111111-2222-4333-8444-555555555555",
      };
      const args = name === "get_subagent_report" ? attempt : { attempts: [attempt] };
      const f = yield* fixture({ name, args });
      const before = f.history();
      expect(
        (yield* f.recovery.confirm(f.context.session.id, "failed-read", f.confirmation)).type,
      ).toBe("recovered");
      expect(f.history()).toEqual(before);
      expect(f.owner.preview(f.context.session.id, "next-report", f.revision.id).status).toBe(
        "bound",
      );
      const changed = {
        name,
        toolCallId: "read-call",
        args:
          name === "get_subagent_report"
            ? { ...attempt, attemptId: "66666666-7777-4888-8999-000000000000" }
            : { attempts: [{ ...attempt, attemptId: "66666666-7777-4888-8999-000000000000" }] },
      };
      f.db.sqlite.prepare("UPDATE owner_rpc_operations SET fingerprint=? WHERE operation_id=1").run(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          operation: "toolAuthorize",
          input: encodeFullLoopValue(changed),
        }),
      );
      expect(f.owner.preview(f.context.session.id, "changed-report", f.revision.id)).toEqual({
        status: "refused",
        reason: "run_outcome_uncertain",
      });
    }),
  20000,
);

it.live(
  "explicit recovery preserves failure, is immutable/idempotent and permits a new binding after reopen",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const before = f.history();
      expect(f.owner.preview(f.context.session.id, "probe", f.revision.id)).toEqual({
        status: "refused",
        reason: "run_outcome_uncertain",
      });
      expect(f.owner.bind(f.context.session.id, "next", f.revision.id)).toEqual({
        status: "refused",
        reason: "run_outcome_uncertain",
      });
      const result = yield* f.recovery.confirm(f.context.session.id, "failed-read", f.confirmation);
      expect(result.type).toBe("recovered");
      expect(f.history()).toEqual(before);
      expect(f.owner.preview(f.context.session.id, "probe", f.revision.id).status).toBe("bound");
      expect(f.history()).toEqual(before);
      expect(
        yield* f.recovery.confirm(f.context.session.id, "failed-read", f.confirmation),
      ).toEqual(result);
      expect(f.db.sqlite.prepare("SELECT count(*) AS n FROM owner_read_recoveries").get()).toEqual({
        n: 1,
      });
      expect(() =>
        f.db.sqlite.exec("UPDATE owner_read_recoveries SET policy='background-result-read-v1'"),
      ).toThrow("immutable");
      expect(() => f.db.sqlite.exec("DELETE FROM owner_read_recoveries")).toThrow("retained");
      expect(f.ledger.reserve(f.key, 2, "different", true).type).toBe("existing");
      expect(f.ledger.reserve(f.key, 3, "new-read", false)).toEqual({
        type: "rejected",
        reason: "uncertain_run",
      });
      expect(f.ledger.reserve(f.key, 3, "new-write", true)).toEqual({
        type: "rejected",
        reason: "uncertain_run",
      });
      const authorization = f.db.sqlite
        .prepare("SELECT fingerprint FROM owner_rpc_operations WHERE operation_id=1")
        .get();
      const fingerprint = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ fingerprint: Schema.String }),
      )(authorization);
      f.db.sqlite.exec("UPDATE owner_rpc_operations SET fingerprint='{}' WHERE operation_id=1");
      expect((yield* f.recovery.assess(f.context.session.id, "failed-read")).type).toBe("blocked");
      expect(f.owner.bind(f.context.session.id, "next", f.revision.id)).toEqual({
        status: "refused",
        reason: "run_outcome_uncertain",
      });
      f.db.sqlite
        .prepare("UPDATE owner_rpc_operations SET fingerprint=? WHERE operation_id=1")
        .run(fingerprint.fingerprint);
      expect(f.history()).toEqual(before);
      const next = yield* Effect.promise(() => f.context.reopen());
      const db = yield* Effect.provideContext(Database, yield* next.contextEffect);
      expect(
        (yield* makeOwnerReadRecovery(db).assess(f.context.session.id, "failed-read")).type,
      ).toBe("recovered");
      const binding = workflowRunBindings(db).bind(f.context.session.id, "next", f.revision.id);
      expect(binding.status).toBe("bound");
      if (binding.status !== "bound") return yield* Effect.die("new binding expected");
      expect(
        makeSqliteOwnerRpcLedger(db).reserve(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(binding.binding),
          1,
          "new-effect",
          true,
        ),
      ).toEqual({ type: "reserved" });
      expect(
        workflowRunBindings(db).bind(f.context.session.id, "failed-read", f.revision.id),
      ).toEqual({ status: "refused", reason: "run_id_conflict" });
    }),
);

it.live.each([
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
] as const)("recovery refuses $0 without changing historical rows or issuing an effect", (reason) =>
  Effect.gen(function* () {
    const f = yield* fixture();
    switch (reason) {
      case "write_tool":
        f.db.sqlite
          .prepare("UPDATE owner_rpc_operations SET fingerprint=? WHERE operation_id=2")
          .run(
            yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
              operation: "tool",
              input: encodeFullLoopValue({ name: "shell", args: {}, toolCallId: "read-call" }),
            }),
          );
        break;
      case "pending":
        f.db.sqlite.exec("UPDATE owner_rpc_operations SET status='pending' WHERE operation_id=2");
        break;
      case "later_operation":
        f.db.sqlite
          .prepare(
            "INSERT INTO owner_rpc_operations SELECT run_id,run_key,3,'{}',0,'{}','succeeded' FROM owner_rpc_operations WHERE operation_id=2",
          )
          .run();
        break;
      case "missing_authorization":
        f.db.sqlite.exec("UPDATE owner_rpc_operations SET fingerprint='{}' WHERE operation_id=1");
        break;
      case "authorization_key_mismatch":
        f.db.sqlite.exec("UPDATE owner_rpc_operations SET run_key='{}' WHERE operation_id=1");
        break;
      case "other_uncertain":
        f.db.sqlite.exec("UPDATE owner_rpc_operations SET status='uncertain' WHERE operation_id=1");
        break;
      case "active_task":
        f.db.sqlite
          .prepare(
            "INSERT INTO work_tasks(id,project_id,origin_session_id,parent_run_id,parent_tool_call_id,agent_name,status,title,request,created_at,updated_at) VALUES('active',?,?,'failed-read','read-call','background_shell','running','','',1,1)",
          )
          .run(f.context.project.id, f.context.session.id);
        break;
      case "wrong_goal":
      case "stale_preview":
        yield* Effect.provideContext(
          f.workflows.updateGoal(f.context.session.id, {
            statement: "Changed revision",
            outcomes: [],
            constraints: [],
            nonGoals: [],
            assumptions: [],
            openQuestions: [],
            status: "active",
          }),
          f.services,
        );
        if (reason === "wrong_goal")
          f.db.sqlite
            .prepare("UPDATE owner_rpc_operations SET run_key='{}' WHERE operation_id=2")
            .run();
        break;
      case "wrong_failure":
        f.db.sqlite.exec("UPDATE owner_workflow_executions SET result_json='{}'");
        break;
      case "wrong_session":
        break;
    }
    const before = f.history();
    const result = yield* f.recovery.confirm(
      reason === "wrong_session" ? "other-session" : f.context.session.id,
      "failed-read",
      f.confirmation,
    );
    expect(result.type).toBe("blocked");
    expect(f.history()).toEqual(before);
    expect(f.db.sqlite.prepare("SELECT count(*) AS n FROM owner_read_recoveries").get()).toEqual({
      n: 0,
    });
    expect(f.context.provider!.adapter.invocations).toHaveLength(0);
  }),
);

it.live.each(["failed", "blocked"] as const)(
  "historical $0 task with no live attempt does not block the target read recovery",
  (status) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.db.sqlite
        .prepare(
          "INSERT INTO work_tasks(id,project_id,origin_session_id,parent_run_id,parent_tool_call_id,agent_name,status,title,request,created_at,updated_at) VALUES('historical',?,?,'older-run','old-call','background_shell',?,'','',1,1)",
        )
        .run(f.context.project.id, f.context.session.id, status);
      const preview = yield* f.recovery.assess(f.context.session.id, "failed-read");
      expect(preview.type).toBe("eligible");
      expect(
        f.db.sqlite
          .prepare("SELECT status,active_attempt_id FROM work_tasks WHERE id='historical'")
          .get(),
      ).toEqual({ status, active_attempt_id: null });
    }),
);

it.live(
  "operator revocation restores admission blocking without changing the original failure or deleting the receipt",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const before = f.history();
      const receipt = yield* f.recovery.confirm(
        f.context.session.id,
        "failed-read",
        f.confirmation,
      );
      if (receipt.type !== "recovered") return yield* Effect.die("recovery expected");
      const input = {
        confirmation: "revoke_read_recovery_without_replay" as const,
        receiptId: receipt.receiptId,
      };
      const result = yield* f.recovery.revoke(f.context.session.id, "failed-read", input);
      expect(result.type).toBe("revoked");
      expect(yield* f.recovery.revoke(f.context.session.id, "failed-read", input)).toEqual(result);
      expect(f.history()).toEqual(before);
      expect(f.owner.bind(f.context.session.id, "new-run", f.revision.id)).toEqual({
        status: "refused",
        reason: "run_outcome_uncertain",
      });
      expect(f.db.sqlite.prepare("SELECT count(*) AS n FROM owner_read_recoveries").get()).toEqual({
        n: 1,
      });
      expect(f.context.provider!.adapter.invocations).toHaveLength(0);
    }),
);

it.live("recovery cannot issue a durable receipt inside an outer transaction", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.db.sqlite.exec("BEGIN");
    try {
      const result = yield* Effect.exit(
        f.recovery.confirm(f.context.session.id, "failed-read", f.confirmation),
      );
      expect(result._tag).toBe("Failure");
      expect(f.db.sqlite.prepare("SELECT count(*) AS n FROM owner_read_recoveries").get()).toEqual({
        n: 0,
      });
    } finally {
      f.db.sqlite.exec("ROLLBACK");
    }
  }),
);

it.live(
  "actual AgentChat allows only a fresh explicit request after recovery and rejects the original run",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.provideContext(selectTestModel(), f.services);
      const request = (runId: string) =>
        new Request("http://localhost/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: f.context.session.id,
            runId,
            messages: [
              { id: "fresh", role: "user", content: "Inspect existing results before continuing" },
            ],
            tools: [],
            context: [],
          }),
        });
      const before = yield* Effect.provideContext(
        f.chat.handle(request("new-run"), f.context.session.id),
        f.services,
      );
      expect(before.status).toBe(409);
      const confirmation = yield* Effect.provideContext(
        f.chat.confirmReadRecovery(f.context.session.id, null, "failed-read", f.confirmation),
        f.services,
      );
      expect(confirmation.status).toBe(200);
      expect(f.context.provider!.adapter.invocations).toHaveLength(0);
      const old = yield* Effect.provideContext(
        f.chat.handle(request("failed-read"), f.context.session.id),
        f.services,
      );
      expect(old.status).toBe(409);
      const response = yield* Effect.provideContext(
        f.chat.handle(request("new-run"), f.context.session.id),
        f.services,
      );
      const body = yield* Effect.promise(() => response.text());
      expect(response.status, body).toBe(200);
      expect(body).not.toContain("worker_execution_failed");
      expect(f.context.provider!.adapter.invocations.length).toBeGreaterThan(0);
      expect(
        f.db.sqlite
          .prepare("SELECT status,error_code FROM chat_runs WHERE run_id='failed-read'")
          .get(),
      ).toEqual({ status: "failed", error_code: "worker_execution_failed" });
    }),
  20000,
);
