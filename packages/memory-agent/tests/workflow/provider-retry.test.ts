import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import {
  Cause,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Layer,
  Path,
  Schema,
  Scope,
} from "effect";
import { TestClock } from "effect/testing";
import { describe, expect } from "vite-plus/test";
import {
  pullModelChunk,
  type OwnerModelStream,
  type ProviderRetryOwner,
} from "../../src/agent/full-loop-provider-retry.ts";
import { encodeFullLoopValue } from "../../src/agent/full-loop-codec.ts";
import { ownerRpcFingerprint } from "../../src/agent/owner-rpc-fingerprint.ts";
import { Database } from "../../src/db/database.ts";
import { SubscriptionStreamFailed } from "../../src/providers/subscription-adapter.ts";
import {
  ExecutionAdmission,
  defaultExecutionAdmissionLimits,
} from "../../src/runtime/execution-admission.ts";
import { WorkflowExecution } from "../../src/workflow/execution.ts";
import { ProviderRetries, providerRetryLayer } from "../../src/workflow/provider-retry.ts";

const open = Effect.fnUntraced(function* (file: string) {
  const scope = yield* Scope.make();
  const database = yield* Effect.provideContext(
    Database,
    yield* Layer.build(Database.layer(file)).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  const context = yield* Layer.build(
    Layer.merge(providerRetryLayer, WorkflowExecution.layer).pipe(
      Layer.provide(ExecutionAdmission.layer(defaultExecutionAdmissionLimits)),
      Layer.provide(Layer.succeed(Database, database)),
    ),
  ).pipe(Effect.provideService(Scope.Scope, scope));
  return {
    database,
    retries: yield* Effect.provideContext(ProviderRetries, context),
    execution: yield* Effect.provideContext(WorkflowExecution, context),
    scope,
  };
});

const tempFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return path.join(yield* fs.makeTempDirectoryScoped({ prefix: "provider-retry-" }), "owner.db");
}).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer]));

const request = { sessionId: "s", runId: "run-1", stage: "connect", firstFailedAt: 0 } as const;

const StoredWait = Schema.Struct({
  status: Schema.String,
  payload: Schema.fromJsonString(Schema.Struct({ retryAt: Schema.Finite, sequence: Schema.Int })),
});
const storedWaits = (database: Database["Service"]) =>
  database.sqlite
    .prepare(
      "SELECT status, payload_json AS payload FROM owner_workflow_executions WHERE workflow_name = 'ProviderRetryWait' ORDER BY execution_id",
    )
    .all()
    .map((row) => Schema.decodeUnknownSync(StoredWait)(row));

const scheduledClocks = (database: Database["Service"]) =>
  database.sqlite
    .prepare("SELECT due_at FROM owner_workflow_clocks WHERE status = 'scheduled'")
    .all();

const settle = Effect.repeat(Effect.yieldNow, { times: 50 });

/** A running Goal execution whose run the previous process left failed. */
const runningGoal = (database: Database["Service"], runId: string) => {
  database.sqlite
    .prepare("INSERT OR REPLACE INTO chat_metadata (namespace, key, value) VALUES (?, ?, ?)")
    .run(
      "memory-agent/workflow-execution",
      "s",
      JSON.stringify({
        kind: "running",
        runId,
        goalVersion: 1,
        planVersion: 1,
        noProgressRuns: 0,
        progress: { completedSteps: [], evidence: [], toolResults: [] },
      }),
    );
  database.sqlite
    .prepare(
      "INSERT INTO chat_runs (run_id, thread_id, status, started_at) VALUES (?, 's', 'failed', 1)",
    )
    .run(runId);
};

describe("durable provider retry", () => {
  it.effect("stores retryAt once and resends only after the durable clock fires", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { database, retries, scope } = yield* open(":memory:");
        const waiting = yield* Effect.forkChild(
          retries.wait({ ...request, retry: 1 }, new AbortController().signal),
        );
        yield* settle;
        const [stored] = storedWaits(database);
        // 2s with at most 20% jitter, persisted before waiting.
        expect(stored?.payload.retryAt).toBeGreaterThanOrEqual(1_600);
        expect(stored?.payload.retryAt).toBeLessThanOrEqual(2_400);
        expect(scheduledClocks(database)).toEqual([{ due_at: stored?.payload.retryAt }]);
        yield* TestClock.adjust(1_500);
        yield* settle;
        expect(waiting.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust(31_000);
        expect(yield* Fiber.join(waiting)).toEqual({ _tag: "Retry" });
        expect(storedWaits(database)).toEqual([{ status: "completed", payload: stored?.payload }]);
        yield* Scope.close(scope, Exit.void);
      }),
    ),
  );

  it.effect("restores a pending wait after the layer is rebuilt without recomputing it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const file = yield* tempFile;
        const first = yield* open(file);
        yield* Effect.forkChild(
          first.retries.wait({ ...request, retry: 3 }, new AbortController().signal),
        );
        yield* settle;
        const before = storedWaits(first.database);
        yield* Scope.close(first.scope, Exit.void);

        const reopened = yield* open(file);
        expect(storedWaits(reopened.database)).toEqual(before);
        const resumed = yield* Effect.forkChild(reopened.retries.awaitRun(request.runId));
        yield* settle;
        expect(resumed.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust(40_000);
        expect(yield* Fiber.join(resumed)).toEqual({ _tag: "Retry" });
        expect(storedWaits(reopened.database)).toEqual([
          { status: "completed", payload: before[0]?.payload },
        ]);
        yield* Scope.close(reopened.scope, Exit.void);
      }),
    ),
  );

  it.effect("cancellation interrupts the wait and removes its timer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { database, retries, scope } = yield* open(":memory:");
        const controller = new AbortController();
        const waiting = yield* Effect.forkChild(
          retries.wait({ ...request, retry: 1 }, controller.signal),
        );
        yield* settle;
        controller.abort();
        expect(yield* Fiber.join(waiting)).toEqual({ _tag: "Cancelled" });
        expect(storedWaits(database).map((wait) => wait.status)).toEqual(["interrupted"]);
        expect(scheduledClocks(database)).toEqual([]);
        yield* Scope.close(scope, Exit.void);
      }),
    ),
  );

  it.effect("stops behind a blocker once retries pass the elapsed-time limit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { database, retries, execution, scope } = yield* open(":memory:");
        runningGoal(database, request.runId);
        yield* TestClock.adjust(Duration.hours(24));
        expect(
          yield* retries.wait({ ...request, retry: 60 }, new AbortController().signal),
        ).toEqual({ _tag: "Exhausted" });
        expect(storedWaits(database)).toEqual([]);
        expect(yield* execution.get("s")).toMatchObject({
          kind: "blocked",
          reason: "external_dependency",
        });
        yield* Scope.close(scope, Exit.void);
      }),
    ),
  );

  it.effect("continues a restarted run whose effects are known at its pending retry time", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { database, execution, scope } = yield* open(":memory:");
        runningGoal(database, "quiet");
        expect(yield* execution.afterRestart("s", "quiet", 9_000)).toMatchObject({
          kind: "retrying",
          runId: "quiet",
          retryAt: 9_000,
        });
        database.sqlite.exec("PRAGMA foreign_keys = OFF");
        const shellRun = (runId: string) => {
          runningGoal(database, runId);
          database.sqlite
            .prepare(
              "INSERT INTO owner_rpc_operations VALUES (?, 'key', 1, ?, 1, '{}', 'succeeded')",
            )
            .run(
              runId,
              ownerRpcFingerprint(
                "tool",
                encodeFullLoopValue({ name: "run_shell", toolCallId: `${runId}-call`, args: {} }),
              ),
            );
        };
        // A succeeded shell call the session history does not hold may be repeated unknowingly.
        shellRun("unrecorded");
        expect(yield* execution.afterRestart("s", "unrecorded", undefined)).toMatchObject({
          kind: "blocked",
          reason: "server_restarted",
        });
        shellRun("recorded");
        database.sqlite
          .prepare(
            "INSERT INTO nodes (id, project_id, session_id, run_id, kind, text, detail, created_at) VALUES ('n', 'p', 's', 'recorded', 'tool_result', 'done', ?, '')",
          )
          .run(JSON.stringify({ toolName: "run_shell", toolCallId: "recorded-call", ok: true }));
        expect(yield* execution.afterRestart("s", "recorded", undefined)).toMatchObject({
          kind: "retrying",
          runId: "recorded",
        });
        yield* Scope.close(scope, Exit.void);
      }),
    ),
  );
});

describe("owner model pull", () => {
  const failing = (reason: SubscriptionStreamFailed["reason"]) =>
    SubscriptionStreamFailed.make({ provider: "openai", reason });
  const iterator = (steps: ReadonlyArray<{ readonly type: string } | Error>) => {
    let index = 0;
    return {
      next: () => {
        const step = steps[index++];
        return step instanceof Error
          ? Promise.reject(step)
          : Promise.resolve(
              step === undefined ? { done: true, value: undefined } : { done: false, value: step },
            );
      },
    };
  };
  const recordingRetries = (waits: number[]): ProviderRetryOwner => ({
    wait: (input) =>
      Effect.sync(() => {
        waits.push(input.retry);
        return { _tag: "Retry" } as const;
      }),
  });
  const pull = (stream: OwnerModelStream, retries: ProviderRetryOwner) =>
    pullModelChunk(stream, retries, new AbortController().signal, (effect) => effect);

  it.effect("resends a request that was never sent on a fresh stream", () =>
    Effect.gen(function* () {
      const waits: number[] = [];
      const stream: OwnerModelStream = {
        iterator: iterator([failing({ _tag: "RequestNotSent", stage: "dns" })]),
        open: () => iterator([{ type: "RUN_STARTED" }, { type: "TEXT_MESSAGE_START" }]),
        delivered: false,
      };
      expect(yield* pull(stream, recordingRetries(waits))).toEqual({
        done: false,
        value: { type: "TEXT_MESSAGE_START" },
      });
      expect(waits).toEqual([1]);
    }),
  );

  it.effect("never resends a request the provider may have received or answered", () =>
    Effect.gen(function* () {
      const waits: number[] = [];
      const unknown = yield* pull(
        {
          iterator: iterator([failing({ _tag: "RequestOutcomeUnknown" })]),
          open: () => iterator([]),
          delivered: false,
        },
        recordingRetries(waits),
      ).pipe(Effect.flip);
      expect(Cause.isUnknownError(unknown) && unknown.cause).toBeInstanceOf(
        SubscriptionStreamFailed,
      );
      const afterOutput: OwnerModelStream = {
        iterator: iterator([
          { type: "TOOL_CALL_START" },
          failing({ _tag: "RequestNotSent", stage: "connect" }),
        ]),
        open: () => iterator([]),
        delivered: false,
      };
      yield* pull(afterOutput, recordingRetries(waits));
      yield* pull(afterOutput, recordingRetries(waits)).pipe(Effect.flip);
      expect(waits).toEqual([]);
    }),
  );
});
