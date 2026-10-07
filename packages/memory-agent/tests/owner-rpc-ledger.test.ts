import { it } from "@effect/vitest";
import { Cause, Deferred, Effect, Equal, Fiber, FileSystem, Path, Schema } from "effect";
import { withTestPlatform } from "./support/platform.ts";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vite-plus/test";
import { makeSqliteOwnerRpcLedger } from "../src/agent/owner-rpc-ledger.ts";
import { makeOwnerRpc, type OwnerRpcCapability } from "../src/agent/owner-rpc.ts";
import { migrations } from "../src/db/migrations.ts";

const sdkCall = Effect.fn("ownerLedgerTest.sdkCall")(function* <A>(
  operation: () => A | PromiseLike<A>,
) {
  return yield* Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  }).pipe(Effect.uninterruptible);
});
const capability: OwnerRpcCapability = {
  runId: "run",
  sessionId: "session",
  goalInstanceId: "goal",
  goalVersion: 1,
  planVersion: null,
  workflowRevisionId: 1,
  generation: "one",
  token: "secret",
};
const keyValue = {
  runId: "run",
  sessionId: "session",
  goalInstanceId: "goal",
  goalVersion: 1,
  planVersion: null,
  workflowRevisionId: 1,
};
const key = JSON.stringify(keyValue);
function owner(sqlite: DatabaseSync) {
  return makeSqliteOwnerRpcLedger({
    sqlite,
    atomic(work) {
      const nested = sqlite.isTransaction;
      sqlite.exec(nested ? "SAVEPOINT ledger" : "BEGIN IMMEDIATE");
      try {
        const result = work();
        sqlite.exec(nested ? "RELEASE ledger" : "COMMIT");
        return result;
      } catch (error) {
        sqlite.exec(nested ? "ROLLBACK TO ledger; RELEASE ledger" : "ROLLBACK");
        throw error;
      }
    },
  });
}
function seed(sqlite: DatabaseSync) {
  sqlite.exec(`INSERT INTO projects (id, root, name, created_at) VALUES ('project', '/test', 'test', 'now');
    INSERT INTO sessions (id, project_id, created_at) VALUES ('session', 'project', 'now');
    INSERT INTO workflow_goal_identities VALUES ('session', 'goal', 'now');
    INSERT INTO workflow_state_revisions
      (id, session_id, state_json, goal_version, plan_version, provenance, created_at, goal_instance_id)
      VALUES (1, 'session', '{}', 1, NULL, 'recorded', 'now', 'goal');
    INSERT INTO workflow_run_bindings VALUES ('run', 'session', 'goal', 1, NULL, 1, 'now');`);
}
const fixture = Effect.fn("ownerLedgerTest.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "owner-ledger-" });
  const file = path.join(dir, "owner.sqlite");
  let sqlite = new DatabaseSync(file);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (sqlite.isOpen) sqlite.close();
    }),
  );
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const step of migrations) sqlite.exec(step);
  seed(sqlite);
  return {
    get sqlite() {
      return sqlite;
    },
    reopen() {
      sqlite.close();
      sqlite = new DatabaseSync(file);
      sqlite.exec("PRAGMA foreign_keys = ON");
    },
    close() {
      if (sqlite.isOpen) sqlite.close();
    },
  };
});

it.live("pending and uncertain effects survive reopen and never reset with a new operation", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    expect(owner(f.sqlite).reserve(key, 1, "effect", true)).toEqual({ type: "reserved" });
    f.reopen();
    const ledger = owner(f.sqlite);
    expect(ledger.reserve(key, 1, "effect", true)).toMatchObject({
      type: "existing",
      record: { reply: { type: "pending" } },
    });
    expect(ledger.reserve(key, 2, "next", true)).toEqual({
      type: "rejected",
      reason: "uncertain_run",
    });
    ledger.settle(key, 1, { type: "uncertain", operationId: 1 });
    f.reopen();
    expect(owner(f.sqlite).reserve(key, 2, "next", true)).toMatchObject({
      reason: "uncertain_run",
    });
    expect(owner(f.sqlite).reserve(key, 2, "read", false)).toEqual({ type: "reserved" });
    expect(() =>
      owner(f.sqlite).settle(key, 1, { type: "succeeded", operationId: 1, output: null }),
    ).toThrow();
    expect(() =>
      owner(f.sqlite).reserve(key.replace('"goal"', '"other"'), 3, "forged", false),
    ).toThrow();
  }).pipe(withTestPlatform),
);

it.live(
  "RPC duplicates after reopen do not execute; wrong generation and late replies are fenced",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      let calls = 0;
      let generation = "one";
      const reply = yield* Deferred.make<string>();
      const runNative = Effect.runPromiseWith(yield* Effect.context());
      const release = (value: string) => Deferred.doneUnsafe(reply, Effect.succeed(value));
      const endpoint = () =>
        makeOwnerRpc<{ effect: { input: null; output: string } }>({
          ledger: owner(f.sqlite),
          permits: (claim) => Equal.equals(claim, { ...capability, generation }),
          handlers: {
            effect: {
              sideEffect: true,
              execute: () => {
                calls++;
                return runNative(Deferred.await(reply));
              },
            },
          },
        });
      const request = {
        type: "owner-rpc-request" as const,
        capability,
        operationId: 1,
        operation: "effect" as const,
        input: null,
      };
      const rpc = endpoint();
      const running = yield* Effect.forkChild(
        sdkCall(() => rpc(request)),
        { startImmediately: true },
      );
      yield* Effect.addFinalizer(() => Deferred.succeed(reply, "fixture cleanup"));
      expect(yield* sdkCall(() => rpc(request))).toMatchObject({ type: "pending" });
      generation = "two";
      release("done");
      expect(yield* Fiber.join(running)).toMatchObject({ reason: "unauthorized" });
      f.reopen();
      const restarted = endpoint();
      expect(yield* sdkCall(() => restarted(request))).toMatchObject({ reason: "unauthorized" });
      expect(
        yield* sdkCall(() => restarted({ ...request, capability: { ...capability, generation } })),
      ).toMatchObject({ type: "succeeded", output: "done" });
      expect(calls).toBe(1);
    }).pipe(withTestPlatform),
);

it.live("outer transactions reject before dispatch and cannot roll back ledger settlement", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    try {
      let calls = 0;
      const ledger = owner(f.sqlite);
      const rpc = makeOwnerRpc<{ effect: { input: null; output: null } }>({
        ledger,
        permits: () => true,
        handlers: {
          effect: {
            sideEffect: true,
            execute: () =>
              Promise.resolve().then(() => {
                calls++;
                expect(f.sqlite.isTransaction).toBe(false);
                expect(f.sqlite.prepare("SELECT status FROM owner_rpc_operations").get()).toEqual({
                  status: "pending",
                });
                return null;
              }),
          },
        },
      });
      const request = {
        type: "owner-rpc-request" as const,
        capability,
        operationId: 1,
        operation: "effect" as const,
        input: null,
      };
      f.sqlite.exec("BEGIN IMMEDIATE");
      yield* sdkCall(() => expect(rpc(request)).rejects.toThrow("standalone transaction"));
      expect(calls).toBe(0);
      f.sqlite.exec("ROLLBACK");
      expect(f.sqlite.prepare("SELECT count(*) AS n FROM owner_rpc_operations").get()).toEqual({
        n: 0,
      });
      expect(yield* sdkCall(() => rpc(request))).toMatchObject({ type: "succeeded" });
      expect(yield* sdkCall(() => rpc(request))).toMatchObject({ type: "succeeded" });
      expect(calls).toBe(1);
      expect(ledger.reserve(key, 2, "second", true)).toEqual({ type: "reserved" });
      f.sqlite.exec("BEGIN IMMEDIATE");
      expect(() =>
        ledger.settle(key, 2, { type: "succeeded", operationId: 2, output: null }),
      ).toThrow("standalone transaction");
      f.sqlite.exec("ROLLBACK");
      f.reopen();
      expect(owner(f.sqlite).reserve(key, 2, "second", true)).toMatchObject({
        type: "existing",
        record: { reply: { type: "pending" } },
      });
      owner(f.sqlite).settle(key, 2, { type: "succeeded", operationId: 2, output: null });
      f.reopen();
      expect(owner(f.sqlite).reserve(key, 2, "second", true)).toMatchObject({
        type: "existing",
        record: { reply: { type: "succeeded" } },
      });
    } finally {
      if (f.sqlite.isTransaction) f.sqlite.exec("ROLLBACK");
    }
  }).pipe(withTestPlatform),
);

it.live("unresolved effects fence a new bound run in the same session and Goal", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const nextKey = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      ...keyValue,
      runId: "next-run",
    });
    f.sqlite
      .exec(`INSERT INTO workflow_run_bindings VALUES ('next-run', 'session', 'goal', 1, NULL, 1, 'now');
      INSERT INTO chat_runs (run_id, thread_id, status, started_at) VALUES ('run', 'session', 'completed', 0)`);
    const ledger = owner(f.sqlite);
    expect(ledger.reserve(key, 1, "effect", true)).toEqual({ type: "reserved" });
    expect(ledger.reserve(nextKey, 1, "effect", true)).toEqual({
      type: "rejected",
      reason: "uncertain_run",
    });
    expect(ledger.reserve(nextKey, 1, "read", false)).toEqual({ type: "reserved" });
    ledger.settle(key, 1, { type: "uncertain", operationId: 1 });
    f.reopen();
    expect(owner(f.sqlite).reserve(nextKey, 2, "effect", true)).toEqual({
      type: "rejected",
      reason: "uncertain_run",
    });
    expect(owner(f.sqlite).reserve(key, 1, "effect", true)).toMatchObject({
      type: "existing",
      record: { reply: { type: "uncertain" } },
    });
  }).pipe(withTestPlatform),
);

it.live("JSON run keys must match every persisted binding field", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const ledger = owner(f.sqlite);
    for (const forged of [
      "not JSON",
      "null",
      "{}",
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        ...keyValue,
        runId: "missing",
      }),
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        ...keyValue,
        sessionId: "other",
      }),
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        ...keyValue,
        goalInstanceId: "other",
      }),
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        ...keyValue,
        goalVersion: 2,
      }),
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        ...keyValue,
        planVersion: 1,
      }),
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        ...keyValue,
        workflowRevisionId: 2,
      }),
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        ...keyValue,
        goalVersion: "1",
      }),
    ]) {
      expect(() => ledger.reserve(forged, 1, "forged", true)).toThrow();
    }
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM owner_rpc_operations").get()).toEqual({
      n: 0,
    });
    expect(ledger.reserve(key, 1, "valid", true)).toEqual({ type: "reserved" });
    const foreignKey = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      ...keyValue,
      sessionId: "other",
    });
    expect(() =>
      ledger.settle(foreignKey, 1, {
        type: "succeeded",
        operationId: 1,
        output: null,
      }),
    ).toThrow();
    expect(ledger.reserve(key, 1, "valid", true)).toMatchObject({
      type: "existing",
      record: { reply: { type: "pending" } },
    });
  }).pipe(withTestPlatform),
);

it.live("additive upgrade has no legacy backfill and failed DDL rolls back atomically", () =>
  Effect.gen(function* () {
    const sqlite = yield* Effect.acquireRelease(
      Effect.sync(() => new DatabaseSync(":memory:")),
      (db) =>
        Effect.sync(() => {
          if (db.isOpen) db.close();
        }),
    );
    try {
      const rpcMigrationIndex = migrations.findIndex((step) =>
        step.includes("CREATE TABLE owner_rpc_operations"),
      );
      expect(rpcMigrationIndex).toBeGreaterThanOrEqual(0);
      const rpcMigration = migrations[rpcMigrationIndex]!;
      for (const step of migrations.slice(0, rpcMigrationIndex)) sqlite.exec(step);
      seed(sqlite);
      sqlite.exec(
        "INSERT INTO chat_runs (run_id, thread_id, status, started_at) VALUES ('legacy', 'session', 'running', 0)",
      );
      sqlite.exec(`PRAGMA user_version = ${rpcMigrationIndex}`);
      sqlite.exec("BEGIN IMMEDIATE");
      sqlite.exec(rpcMigration);
      expect(sqlite.prepare("SELECT count(*) AS n FROM owner_rpc_operations").get()).toEqual({
        n: 0,
      });
      expect(sqlite.prepare("SELECT run_id FROM workflow_run_bindings").all()).toEqual([
        { run_id: "run" },
      ]);
      expect(() => sqlite.exec(rpcMigration)).toThrow();
      sqlite.exec("ROLLBACK");
      expect(
        sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'owner_rpc_operations'").get(),
      ).toBeUndefined();
      expect(sqlite.prepare("PRAGMA user_version").get()).toEqual({
        user_version: rpcMigrationIndex,
      });
      sqlite.exec(rpcMigration);
      expect(() =>
        owner(sqlite).reserve(key.replace('"run"', '"legacy"'), 1, "effect", true),
      ).toThrow();
    } finally {
      sqlite.close();
    }
  }).pipe(withTestPlatform),
);
