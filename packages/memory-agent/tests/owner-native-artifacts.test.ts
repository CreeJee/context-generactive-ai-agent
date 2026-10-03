import {
  chmodSync,
  readdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { OwnerNativeFiles } from "../src/agent/owner-native-files.ts";
import { NativeRegistrationError } from "../src/agent/owner-native-artifacts.ts";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Schema } from "effect";
import { expect, test } from "vite-plus/test";
import { makeOwnerNativeArtifacts } from "../src/agent/owner-native-artifacts.ts";
import { Database } from "../src/db/database.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { StorageRoot } from "../src/config/storage-root.ts";
import { testRuntime } from "./support/runtime.ts";

test("owner builds and registers once, cold acquisition revalidates bytes and rejects tampering", async () => {
  const context = await testRuntime();
  try {
    const owner = await context.runtime.runPromise(
      Effect.all({ db: Database, workflows: Workflows, storage: StorageRoot }),
    );
    await context.runtime.runPromise(
      owner.workflows.updateGoal(context.session.id, {
        statement: "Native registration",
        outcomes: ["Verified owner provenance"],
        constraints: [],
        nonGoals: [],
        assumptions: [],
        openQuestions: [],
        status: "active",
      }),
    );
    const id = Schema.decodeUnknownSync(Schema.Struct({ goal_instance_id: Schema.String }))(
      owner.db.sqlite
        .prepare("SELECT goal_instance_id FROM workflow_goal_instances WHERE session_id = ?")
        .get(context.session.id),
    ).goal_instance_id;
    const options = { ...owner.db, directory: join(owner.storage.path, "native-artifacts") };
    const acquire = () => Effect.scoped(makeOwnerNativeArtifacts(options).acquire(id));
    await context.runtime.runPromise(acquire());
    const read = () =>
      Schema.decodeUnknownSync(
        Schema.Struct({
          artifact_url: Schema.String,
          artifact_hash: Schema.String,
          source_hash: Schema.String,
          contract_version: Schema.String,
          created_at: Schema.String,
        }),
      )(
        owner.db.sqlite
          .prepare("SELECT * FROM workflow_goal_native_artifacts WHERE goal_instance_id = ?")
          .get(id),
      );
    const registered = read();
    expect(registered.source_hash).toHaveLength(64);
    expect(registered.contract_version).toBe("native-factories/v1");
    expect(Number.isFinite(Date.parse(registered.created_at))).toBe(true);
    expect(() =>
      owner.db.sqlite
        .prepare(
          "UPDATE workflow_goal_native_artifacts SET artifact_hash = ? WHERE goal_instance_id = ?",
        )
        .run("0".repeat(64), id),
    ).toThrow("native registration is immutable");
    expect(() =>
      owner.db.sqlite
        .prepare("DELETE FROM workflow_goal_native_artifacts WHERE goal_instance_id = ?")
        .run(id),
    ).toThrow("native registration is immutable");
    owner.db.sqlite
      .prepare("INSERT INTO workflow_goal_worker_generations VALUES (?, ?, ?, ?, ?)")
      .run(id, "registered-generation", "0".repeat(64), "file:///tmp/worker.mjs", "test");
    await context.runtime.runPromise(acquire());
    expect(read()).toEqual(registered);
    const path = fileURLToPath(registered.artifact_url);
    const outside = join(owner.storage.path, "escaped-native.mjs");
    renameSync(path, outside);
    symlinkSync(outside, path);
    try {
      await expect(context.runtime.runPromise(acquire())).rejects.toMatchObject({
        _tag: "NativeRegistrationError",
      });
      expect(read()).toEqual(registered);
    } finally {
      unlinkSync(path);
      renameSync(outside, path);
    }
    chmodSync(path, 0o600);
    writeFileSync(path, "// tampered\n");
    await expect(context.runtime.runPromise(acquire())).rejects.toMatchObject({
      reason: "integrity",
    });
    expect(read()).toEqual(registered);
  } finally {
    await context.runtime.dispose();
  }
}, 60000);

test("first registration refuses SDK-only history committed during the build", async () => {
  const context = await testRuntime();
  try {
    const owner = await context.runtime.runPromise(
      Effect.all({ db: Database, workflows: Workflows, storage: StorageRoot }),
    );
    await context.runtime.runPromise(
      owner.workflows.updateGoal(context.session.id, {
        statement: "Concurrent historical generation",
        outcomes: ["No native backfill"],
        constraints: [],
        nonGoals: [],
        assumptions: [],
        openQuestions: [],
        status: "active",
      }),
    );
    const id = Schema.decodeUnknownSync(Schema.Struct({ goal_instance_id: Schema.String }))(
      owner.db.sqlite
        .prepare("SELECT goal_instance_id FROM workflow_goal_instances WHERE session_id = ?")
        .get(context.session.id),
    ).goal_instance_id;
    let injected = false;
    const artifacts = makeOwnerNativeArtifacts({
      ...owner.db,
      directory: join(owner.storage.path, "native-artifacts"),
      atomic: <T>(work: () => T): T => {
        owner.db.atomic(() => {
          owner.db.sqlite
            .prepare("INSERT INTO workflow_goal_worker_generations VALUES (?, ?, ?, ?, ?)")
            .run(id, "concurrent-sdk-only", "0".repeat(64), "file:///tmp/old-worker.mjs", "test");
        });
        injected = true;
        return owner.db.atomic(work);
      },
    });
    await expect(
      context.runtime.runPromise(Effect.scoped(artifacts.acquire(id))),
    ).rejects.toMatchObject({
      _tag: "NativeRegistrationError",
      cause: { message: "Historical Goal has no native provenance; backfill refused" },
    });
    expect(injected).toBe(true);
    expect(artifacts.registered(id)).toBe(false);
    expect(readdirSync(join(owner.storage.path, "native-artifacts"))).toEqual([]);
    expect(
      owner.db.sqlite
        .prepare("SELECT 1 FROM workflow_goal_worker_generations WHERE goal_instance_id = ?")
        .get(id),
    ).toBeDefined();
  } finally {
    await context.runtime.dispose();
  }
}, 60000);

for (const fault of [
  "write",
  "integrity",
  "cancel",
  "build-cancel",
  "conflict",
  "after-commit",
  "commit-cancel",
] as const) {
  test(`scoped native lease handles ${fault} without deleting registered generations`, async () => {
    const context = await testRuntime();
    try {
      const owner = await context.runtime.runPromise(
        Effect.all({ db: Database, workflows: Workflows, storage: StorageRoot }),
      );
      await context.runtime.runPromise(
        owner.workflows.updateGoal(context.session.id, {
          statement: "Scoped native resources",
          outcomes: ["No leaked unregistered generation"],
          constraints: [],
          nonGoals: [],
          assumptions: [],
          openQuestions: [],
          status: "active",
        }),
      );
      const id = Schema.decodeUnknownSync(Schema.Struct({ goal_instance_id: Schema.String }))(
        owner.db.sqlite
          .prepare("SELECT goal_instance_id FROM workflow_goal_instances WHERE session_id = ?")
          .get(context.session.id),
      ).goal_instance_id;
      const directory = join(owner.storage.path, "native-artifacts");
      const files = OwnerNativeFiles.production;
      const entered = Deferred.makeUnsafe<void>();
      const release = Deferred.makeUnsafe<void>();
      const controller = new AbortController();
      const retained =
        fault === "after-commit" || fault === "commit-cancel" || fault === "conflict";
      const artifacts = makeOwnerNativeArtifacts({
        ...owner.db,
        directory,
        files: {
          ...files,
          read: (path) =>
            Effect.gen(function* () {
              const bytes = yield* files.read(path);
              if (fault === "build-cancel") {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }
              return bytes;
            }),
          write: (path, code) =>
            Effect.gen(function* () {
              switch (fault) {
                case "write":
                  yield* files.write(path, code);
                  return yield* new NativeRegistrationError({
                    cause: new Error("write fault after creation"),
                  });
                case "integrity":
                  return yield* files.write(path, "throw new Error('load fault');");
                case "cancel":
                  yield* files.write(path, code);
                  yield* Deferred.succeed(entered, undefined);
                  return yield* Deferred.await(release);
                case "conflict":
                  yield* files.write(path, code);
                  expect(readdirSync(directory)).toHaveLength(1);
                  yield* Effect.scoped(
                    makeOwnerNativeArtifacts({ ...owner.db, directory })
                      .acquire(id)
                      .pipe(Effect.mapError((cause) => new NativeRegistrationError({ cause }))),
                  );
                  expect(readdirSync(directory)).toHaveLength(2);
                  return;
                case "build-cancel":
                case "commit-cancel":
                case "after-commit":
                  return yield* files.write(path, code);
              }
            }),
        },
        atomic: <T>(work: () => T): T => {
          const result = owner.db.atomic(work);
          if (fault === "commit-cancel") controller.abort();
          if (fault === "after-commit") throw new Error("uncertain response after commit");
          return result;
        },
      });
      await context.runtime.runPromise(files.parent(directory));
      expect(readdirSync(directory)).toEqual([]);
      if (fault === "cancel" || fault === "build-cancel") {
        await context.runtime.runPromise(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(Effect.scoped(artifacts.acquire(id)));
            yield* Deferred.await(entered);
            expect(readdirSync(directory)).toHaveLength(fault === "cancel" ? 1 : 0);
            yield* Fiber.interrupt(fiber);
          }),
        );
      } else {
        await expect(
          context.runtime.runPromise(Effect.scoped(artifacts.acquire(id)), {
            signal: controller.signal,
          }),
        ).rejects.toBeDefined();
      }
      expect(readdirSync(directory)).toHaveLength(retained ? 1 : 0);
      expect(artifacts.registered(id)).toBe(retained);
      if (retained) {
        await context.runtime.runPromise(
          Effect.scoped(makeOwnerNativeArtifacts({ ...owner.db, directory }).acquire(id)),
        );
        expect(readdirSync(directory)).toHaveLength(1);
      }
    } finally {
      await context.runtime.dispose();
    }
  }, 60000);
}

for (const kind of ["unknown", "sdk-only"] as const) {
  test(`native acquisition rejects ${kind} origin without auto adoption`, async () => {
    const context = await testRuntime();
    try {
      const owner = await context.runtime.runPromise(
        Effect.all({ db: Database, workflows: Workflows, storage: StorageRoot }),
      );
      await context.runtime.runPromise(
        owner.workflows.updateGoal(context.session.id, {
          statement: "Refuse unsupported adoption",
          outcomes: ["No invented provenance"],
          constraints: [],
          nonGoals: [],
          assumptions: [],
          openQuestions: [],
          status: "active",
        }),
      );
      const id = Schema.decodeUnknownSync(Schema.Struct({ goal_instance_id: Schema.String }))(
        owner.db.sqlite
          .prepare("SELECT goal_instance_id FROM workflow_goal_instances WHERE session_id = ?")
          .get(context.session.id),
      ).goal_instance_id;
      switch (kind) {
        case "unknown":
          owner.db.sqlite
            .prepare("INSERT INTO workflow_goal_native_artifacts VALUES (?, ?, ?, ?, ?, ?)")
            .run(
              id,
              "file:///tmp/manual-native.mjs",
              "0".repeat(64),
              "native-factories/v1",
              "0".repeat(64),
              "test",
            );
          break;
        case "sdk-only":
          owner.db.sqlite
            .prepare("INSERT INTO workflow_goal_worker_generations VALUES (?, ?, ?, ?, ?)")
            .run(id, "historical-sdk-only", "0".repeat(64), "file:///tmp/old-worker.mjs", "test");
          break;
      }
      const acquire = Effect.scoped(
        makeOwnerNativeArtifacts({
          ...owner.db,
          directory: join(owner.storage.path, "native-artifacts"),
        }).acquire(id),
      );
      await expect(context.runtime.runPromise(acquire)).rejects.toMatchObject({
        _tag: "NativeRegistrationError",
      });
    } finally {
      await context.runtime.dispose();
    }
  });
}
