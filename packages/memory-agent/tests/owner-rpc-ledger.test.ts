import { it } from "@effect/vitest";
import { Cause, Deferred, Effect, Equal, Fiber, FileSystem, Path, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { withTestPlatform } from "./support/platform.ts";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vite-plus/test";
import { makeSqliteOwnerRpcLedger } from "../src/agent/owner-rpc-ledger.ts";
import {
  makeOwnerRpc,
  makeOwnerRpcEffect,
  type OwnerRpcCapability,
} from "../src/agent/owner-rpc.ts";
import { connectionContext } from "../src/db/database.ts";
import { migrations } from "../src/db/migrations.ts";
import {
  ownerRpcCanonicalJson,
  compactLegacyOwnerRpcFingerprint,
} from "../src/agent/owner-rpc-fingerprint.ts";
import { migrateOwnerRpcFingerprintBatch } from "../src/agent/owner-rpc-fingerprint-migration.ts";

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
/** Runs `effect` with an SqlClient over the fixture's current connection. */
const over =
  (sqlite: DatabaseSync) =>
  <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.flatMap(connectionContext(sqlite), (context) => Effect.provideContext(effect, context));
const owner = (sqlite: DatabaseSync) => over(sqlite)(makeSqliteOwnerRpcLedger);
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
    expect(yield* (yield* owner(f.sqlite)).reserve(key, 1, "effect", true)).toEqual({
      type: "reserved",
    });
    f.reopen();
    const ledger = yield* owner(f.sqlite);
    expect(yield* ledger.reserve(key, 1, "effect", true)).toMatchObject({
      type: "existing",
      record: { reply: { type: "pending" } },
    });
    expect(yield* ledger.reserve(key, 2, "next", true)).toEqual({
      type: "rejected",
      reason: "uncertain_run",
    });
    yield* ledger.settle(key, 1, { type: "uncertain", operationId: 1 });
    f.reopen();
    const reopened = yield* owner(f.sqlite);
    expect(yield* reopened.reserve(key, 2, "next", true)).toMatchObject({
      reason: "uncertain_run",
    });
    expect(yield* reopened.reserve(key, 2, "read", false)).toEqual({ type: "reserved" });
    expect(
      yield* reopened
        .settle(key, 1, { type: "succeeded", operationId: 1, output: null })
        .pipe(Effect.flip),
    ).toMatchObject({ _tag: "OwnerRpcLedgerError", reason: "unreserved" });
    expect(
      yield* reopened
        .reserve(key.replace('"goal"', '"other"'), 3, "forged", false)
        .pipe(Effect.flip),
    ).toMatchObject({ _tag: "OwnerRpcLedgerError", reason: "unbound_run" });
  }).pipe(withTestPlatform),
);

it.live("legacy and compact persisted requests replay identically without executing again", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const runKey = ownerRpcCanonicalJson(keyValue);
    const input = { context: "history".repeat(1000) };
    const legacy = ownerRpcCanonicalJson({ operation: "effect", input });
    const ledger = yield* owner(f.sqlite);
    yield* ledger.reserve(runKey, 1, legacy, true);
    yield* ledger.settle(runKey, 1, {
      type: "succeeded",
      operationId: 1,
      output: "original result",
    });
    let calls = 0;
    const endpoint = Effect.suspend(() => owner(f.sqlite)).pipe(
      Effect.map((reopened) =>
        makeOwnerRpc<{ effect: { input: { context: string }; output: string } }>({
          ledger: reopened,
          permits: () => Effect.succeed(true),
          handlers: {
            effect: {
              sideEffect: true,
              execute: () => {
                calls++;
                return Promise.resolve("must not execute");
              },
            },
          },
        }),
      ),
    );
    const request = {
      type: "owner-rpc-request" as const,
      capability,
      operationId: 1,
      operation: "effect" as const,
      input,
    };
    f.reopen();
    const first = yield* endpoint;
    expect(yield* sdkCall(() => first(request))).toMatchObject({ output: "original result" });
    const before = f.sqlite
      .prepare(
        "SELECT run_id,run_key,operation_id,side_effect,reply_json,status FROM owner_rpc_operations",
      )
      .all();
    const migration = yield* over(f.sqlite)(migrateOwnerRpcFingerprintBatch(0, 1));
    expect(migration.migrated).toBe(1);
    expect(
      f.sqlite
        .prepare(
          "SELECT run_id,run_key,operation_id,side_effect,reply_json,status FROM owner_rpc_operations",
        )
        .all(),
    ).toEqual(before);
    expect(f.sqlite.prepare("SELECT fingerprint FROM owner_rpc_operations").get()).toEqual({
      fingerprint: compactLegacyOwnerRpcFingerprint(legacy),
    });
    f.reopen();
    const second = yield* endpoint;
    expect(yield* sdkCall(() => second(request))).toMatchObject({ output: "original result" });
    const third = yield* endpoint;
    expect(
      yield* sdkCall(() => third({ ...request, input: { context: "different" } })),
    ).toMatchObject({ reason: "operation_conflict" });
    expect(calls).toBe(0);
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
      const endpoint = Effect.suspend(() => owner(f.sqlite)).pipe(
        Effect.map((ledger) =>
          makeOwnerRpc<{ effect: { input: null; output: string } }>({
            ledger,
            permits: (claim) =>
              Effect.sync(() => Equal.equals(claim, { ...capability, generation })),
            handlers: {
              effect: {
                sideEffect: true,
                execute: () => {
                  calls++;
                  return runNative(Deferred.await(reply));
                },
              },
            },
          }),
        ),
      );
      const request = {
        type: "owner-rpc-request" as const,
        capability,
        operationId: 1,
        operation: "effect" as const,
        input: null,
      };
      const rpc = yield* endpoint;
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
      const restarted = yield* endpoint;
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
    let calls = 0;
    yield* over(f.sqlite)(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ledger = yield* makeSqliteOwnerRpcLedger;
        const rpc = makeOwnerRpcEffect<{ effect: { input: null; output: null } }>({
          ledger,
          permits: () => Effect.succeed(true),
          handlers: {
            effect: {
              sideEffect: true,
              execute: () =>
                Effect.sync(() => {
                  calls++;
                  expect(f.sqlite.isTransaction).toBe(false);
                  expect(f.sqlite.prepare("SELECT status FROM owner_rpc_operations").get()).toEqual(
                    { status: "pending" },
                  );
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
        expect(yield* sql.withTransaction(rpc(request)).pipe(Effect.flip)).toMatchObject({
          _tag: "OwnerRpcFailure",
          phase: "reserve",
          cause: expect.objectContaining({ reason: "outer_transaction" }),
        });
        expect(calls).toBe(0);
        expect(f.sqlite.prepare("SELECT count(*) AS n FROM owner_rpc_operations").get()).toEqual({
          n: 0,
        });
        expect(yield* rpc(request)).toMatchObject({ type: "succeeded" });
        expect(yield* rpc(request)).toMatchObject({ type: "succeeded" });
        expect(calls).toBe(1);
        expect(yield* ledger.reserve(key, 2, "second", true)).toEqual({ type: "reserved" });
        expect(
          yield* sql
            .withTransaction(
              ledger.settle(key, 2, { type: "succeeded", operationId: 2, output: null }),
            )
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "outer_transaction" });
      }),
    );
    f.reopen();
    const reopened = yield* owner(f.sqlite);
    expect(yield* reopened.reserve(key, 2, "second", true)).toMatchObject({
      type: "existing",
      record: { reply: { type: "pending" } },
    });
    yield* reopened.settle(key, 2, { type: "succeeded", operationId: 2, output: null });
    f.reopen();
    expect(yield* (yield* owner(f.sqlite)).reserve(key, 2, "second", true)).toMatchObject({
      type: "existing",
      record: { reply: { type: "succeeded" } },
    });
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
    const ledger = yield* owner(f.sqlite);
    expect(yield* ledger.reserve(key, 1, "effect", true)).toEqual({ type: "reserved" });
    expect(yield* ledger.reserve(nextKey, 1, "effect", true)).toEqual({
      type: "rejected",
      reason: "uncertain_run",
    });
    expect(yield* ledger.reserve(nextKey, 1, "read", false)).toEqual({ type: "reserved" });
    yield* ledger.settle(key, 1, { type: "uncertain", operationId: 1 });
    f.reopen();
    const reopened = yield* owner(f.sqlite);
    expect(yield* reopened.reserve(nextKey, 2, "effect", true)).toEqual({
      type: "rejected",
      reason: "uncertain_run",
    });
    expect(yield* reopened.reserve(key, 1, "effect", true)).toMatchObject({
      type: "existing",
      record: { reply: { type: "uncertain" } },
    });
  }).pipe(withTestPlatform),
);

it.live("JSON run keys must match every persisted binding field", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const ledger = yield* owner(f.sqlite);
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
      expect(yield* ledger.reserve(forged, 1, "forged", true).pipe(Effect.flip)).toMatchObject({
        _tag: "OwnerRpcLedgerError",
      });
    }
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM owner_rpc_operations").get()).toEqual({
      n: 0,
    });
    expect(yield* ledger.reserve(key, 1, "valid", true)).toEqual({ type: "reserved" });
    const foreignKey = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      ...keyValue,
      sessionId: "other",
    });
    expect(
      yield* ledger
        .settle(foreignKey, 1, { type: "succeeded", operationId: 1, output: null })
        .pipe(Effect.flip),
    ).toMatchObject({ _tag: "OwnerRpcLedgerError", reason: "unbound_run" });
    expect(yield* ledger.reserve(key, 1, "valid", true)).toMatchObject({
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
      expect(
        yield* (yield* owner(sqlite))
          .reserve(key.replace('"run"', '"legacy"'), 1, "effect", true)
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "OwnerRpcLedgerError", reason: "unbound_run" });
    } finally {
      sqlite.close();
    }
  }).pipe(withTestPlatform),
);
