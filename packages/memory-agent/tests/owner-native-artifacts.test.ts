import { OwnerNativeBuild } from "../src/agent/owner-native-build.ts";
import { OwnerNativeArtifacts } from "../src/agent/owner-native-artifacts.ts";
import { Layer } from "effect";
import { it } from "@effect/vitest";
import { withTestPlatform } from "./support/platform.ts";
import { OwnerNativeFiles } from "../src/agent/owner-native-files.ts";
import { NativeRegistrationError } from "../src/agent/owner-native-artifacts.ts";
import { Cause, Deferred, Effect, Fiber, FileSystem, Path, Schema } from "effect";
import { expect } from "vite-plus/test";
import { makeOwnerNativeArtifacts } from "../src/agent/owner-native-artifacts.ts";
import { Database } from "../src/db/database.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { StorageRoot } from "../src/config/storage-root.ts";
import { testRuntime } from "./support/runtime.ts";

it.live(
  "unavailable build source does not prevent service startup and fails only a requested build",
  () =>
    withTestPlatform(
      Effect.gen(function* () {
        const context = yield* fixture();
        const expected = new Error("Unavailable controlled build source");
        let lookups = 0;
        yield* Effect.provideContext(
          Effect.scoped(
            Effect.gen(function* () {
              const services = yield* Layer.build(
                OwnerNativeArtifacts.layer.pipe(
                  Layer.provide(
                    Layer.succeed(OwnerNativeBuild, {
                      get entry(): string {
                        lookups++;
                        throw expected;
                      },
                    }),
                  ),
                ),
              );
              const artifacts = yield* Effect.provideContext(OwnerNativeArtifacts, services);
              expect(lookups).toBe(0);
              const failure = yield* Effect.flip(artifacts.acquire("unavailable-source"));
              expect(failure).toBeInstanceOf(NativeRegistrationError);
              expect(failure.cause).toBe(expected);
              expect(lookups).toBe(1);
              expect(artifacts.registered("unavailable-source")).toBe(false);
            }),
          ),
          yield* context.runtime.contextEffect,
        );
      }),
    ),
);

it.live(
  "owner builds and registers once, cold acquisition revalidates bytes and rejects tampering",
  () =>
    withTestPlatform(
      Effect.gen(function* () {
        const context = yield* fixture();
        const fs = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const join = pathService.join;
        const runtimeServices = yield* context.runtime.contextEffect;
        const runNative = Effect.runPromiseWith(runtimeServices);
        {
          const owner = yield* Effect.provideContext(
            Effect.all({ db: Database, workflows: Workflows, storage: StorageRoot }),
            runtimeServices,
          );
          yield* Effect.provideContext(
            owner.workflows.updateGoal(context.session.id, {
              statement: "Native registration",
              outcomes: ["Verified owner provenance"],
              constraints: [],
              nonGoals: [],
              assumptions: [],
              openQuestions: [],
              status: "active",
            }),
            runtimeServices,
          );
          const id = (yield* Schema.decodeUnknownEffect(
            Schema.Struct({ goal_instance_id: Schema.String }),
          )(
            owner.db.sqlite
              .prepare("SELECT goal_instance_id FROM workflow_goal_instances WHERE session_id = ?")
              .get(context.session.id),
          )).goal_instance_id;
          const options = { ...owner.db, directory: join(owner.storage.path, "native-artifacts") };
          const acquire = () => Effect.scoped(makeOwnerNativeArtifacts(options).acquire(id));
          yield* Effect.provideContext(acquire(), runtimeServices);
          const read = Effect.fn("OwnerNativeTest.read")(function* () {
            return yield* Schema.decodeUnknownEffect(
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
          });
          const registered = yield* read();
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
          yield* Effect.provideContext(acquire(), runtimeServices);
          expect(yield* read()).toEqual(registered);
          const path = yield* pathService.fromFileUrl(new URL(registered.artifact_url));
          const outside = join(owner.storage.path, "escaped-native.mjs");
          yield* fs.rename(path, outside);
          yield* fs.symlink(outside, path);
          try {
            yield* sdkCall(() =>
              expect(runNative(acquire())).rejects.toMatchObject({
                _tag: "NativeRegistrationError",
              }),
            );
            expect(yield* read()).toEqual(registered);
          } finally {
            yield* fs.remove(path);
            yield* fs.rename(outside, path);
          }
          yield* fs.chmod(path, 0o600);
          yield* fs.writeFileString(path, "// tampered\n");
          yield* sdkCall(() =>
            expect(runNative(acquire())).rejects.toMatchObject({
              reason: "integrity",
            }),
          );
          expect(yield* read()).toEqual(registered);
        }
      }),
    ),
  60000,
);

it.live(
  "first registration refuses SDK-only history committed during the build",
  () =>
    withTestPlatform(
      Effect.gen(function* () {
        const context = yield* fixture();
        const fs = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const join = pathService.join;
        const runtimeServices = yield* context.runtime.contextEffect;
        const runNative = Effect.runPromiseWith(runtimeServices);
        {
          const owner = yield* Effect.provideContext(
            Effect.all({ db: Database, workflows: Workflows, storage: StorageRoot }),
            runtimeServices,
          );
          yield* Effect.provideContext(
            owner.workflows.updateGoal(context.session.id, {
              statement: "Concurrent historical generation",
              outcomes: ["No native backfill"],
              constraints: [],
              nonGoals: [],
              assumptions: [],
              openQuestions: [],
              status: "active",
            }),
            runtimeServices,
          );
          const id = (yield* Schema.decodeUnknownEffect(
            Schema.Struct({ goal_instance_id: Schema.String }),
          )(
            owner.db.sqlite
              .prepare("SELECT goal_instance_id FROM workflow_goal_instances WHERE session_id = ?")
              .get(context.session.id),
          )).goal_instance_id;
          let injected = false;
          const artifacts = makeOwnerNativeArtifacts({
            ...owner.db,
            directory: join(owner.storage.path, "native-artifacts"),
            atomic: <T>(work: () => T): T => {
              owner.db.atomic(() => {
                owner.db.sqlite
                  .prepare("INSERT INTO workflow_goal_worker_generations VALUES (?, ?, ?, ?, ?)")
                  .run(
                    id,
                    "concurrent-sdk-only",
                    "0".repeat(64),
                    "file:///tmp/old-worker.mjs",
                    "test",
                  );
              });
              injected = true;
              return owner.db.atomic(work);
            },
          });
          yield* sdkCall(() =>
            expect(runNative(Effect.scoped(artifacts.acquire(id)))).rejects.toMatchObject({
              _tag: "NativeRegistrationError",
              cause: { message: "Historical Goal has no native provenance; backfill refused" },
            }),
          );
          expect(injected).toBe(true);
          expect(artifacts.registered(id)).toBe(false);
          expect(yield* fs.readDirectory(join(owner.storage.path, "native-artifacts"))).toEqual([]);
          expect(
            owner.db.sqlite
              .prepare("SELECT 1 FROM workflow_goal_worker_generations WHERE goal_instance_id = ?")
              .get(id),
          ).toBeDefined();
        }
      }),
    ),
  60000,
);

for (const fault of [
  "write",
  "integrity",
  "cancel",
  "build-cancel",
  "conflict",
  "after-commit",
  "commit-cancel",
] as const) {
  it.live(
    `scoped native lease handles ${fault} without deleting registered generations`,
    () => {
      const controller = new AbortController();
      return withTestPlatform(
        Effect.gen(function* () {
          const context = yield* fixture();
          const fs = yield* FileSystem.FileSystem;
          const pathService = yield* Path.Path;
          const join = pathService.join;
          const runtimeServices = yield* context.runtime.contextEffect;
          const runNative = Effect.runPromiseWith(runtimeServices);
          {
            const owner = yield* Effect.provideContext(
              Effect.all({ db: Database, workflows: Workflows, storage: StorageRoot }),
              runtimeServices,
            );
            yield* Effect.provideContext(
              owner.workflows.updateGoal(context.session.id, {
                statement: "Scoped native resources",
                outcomes: ["No leaked unregistered generation"],
                constraints: [],
                nonGoals: [],
                assumptions: [],
                openQuestions: [],
                status: "active",
              }),
              runtimeServices,
            );
            const id = (yield* Schema.decodeUnknownEffect(
              Schema.Struct({ goal_instance_id: Schema.String }),
            )(
              owner.db.sqlite
                .prepare(
                  "SELECT goal_instance_id FROM workflow_goal_instances WHERE session_id = ?",
                )
                .get(context.session.id),
            )).goal_instance_id;
            const directory = join(owner.storage.path, "native-artifacts");
            const files = OwnerNativeFiles.production;
            const entered = Deferred.makeUnsafe<void>();
            const release = Deferred.makeUnsafe<void>();
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
                        return yield* NativeRegistrationError.make({
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
                        expect(
                          yield* fs
                            .readDirectory(directory)
                            .pipe(
                              Effect.mapError((cause) => NativeRegistrationError.make({ cause })),
                            ),
                        ).toHaveLength(1);
                        yield* Effect.scoped(
                          makeOwnerNativeArtifacts({ ...owner.db, directory })
                            .acquire(id)
                            .pipe(
                              Effect.mapError((cause) => NativeRegistrationError.make({ cause })),
                            ),
                        );
                        expect(
                          yield* fs
                            .readDirectory(directory)
                            .pipe(
                              Effect.mapError((cause) => NativeRegistrationError.make({ cause })),
                            ),
                        ).toHaveLength(2);
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
            yield* Effect.provideContext(files.parent(directory), runtimeServices);
            expect(yield* fs.readDirectory(directory)).toEqual([]);
            if (fault === "cancel" || fault === "build-cancel") {
              yield* Effect.provideContext(
                Effect.gen(function* () {
                  const fiber = yield* Effect.forkChild(Effect.scoped(artifacts.acquire(id)));
                  yield* Deferred.await(entered);
                  expect(yield* fs.readDirectory(directory)).toHaveLength(
                    fault === "cancel" ? 1 : 0,
                  );
                  yield* Fiber.interrupt(fiber);
                }),
                runtimeServices,
              );
            } else {
              yield* sdkCall(() =>
                expect(
                  runNative(Effect.scoped(artifacts.acquire(id)), {
                    signal: controller.signal,
                  }),
                ).rejects.toBeDefined(),
              );
            }
            expect(yield* fs.readDirectory(directory)).toHaveLength(retained ? 1 : 0);
            expect(artifacts.registered(id)).toBe(retained);
            if (retained) {
              yield* Effect.provideContext(
                Effect.scoped(makeOwnerNativeArtifacts({ ...owner.db, directory }).acquire(id)),
                runtimeServices,
              );
              expect(
                yield* fs
                  .readDirectory(directory)
                  .pipe(Effect.mapError((cause) => NativeRegistrationError.make({ cause }))),
              ).toHaveLength(1);
            }
          }
        }),
      );
    },
    60000,
  );
}

for (const kind of ["unknown", "sdk-only"] as const) {
  it.live(`native acquisition rejects ${kind} origin without auto adoption`, () =>
    withTestPlatform(
      Effect.gen(function* () {
        const context = yield* fixture();
        const pathService = yield* Path.Path;
        const join = pathService.join;
        const runtimeServices = yield* context.runtime.contextEffect;
        const runNative = Effect.runPromiseWith(runtimeServices);
        {
          const owner = yield* Effect.provideContext(
            Effect.all({ db: Database, workflows: Workflows, storage: StorageRoot }),
            runtimeServices,
          );
          yield* Effect.provideContext(
            owner.workflows.updateGoal(context.session.id, {
              statement: "Refuse unsupported adoption",
              outcomes: ["No invented provenance"],
              constraints: [],
              nonGoals: [],
              assumptions: [],
              openQuestions: [],
              status: "active",
            }),
            runtimeServices,
          );
          const id = (yield* Schema.decodeUnknownEffect(
            Schema.Struct({ goal_instance_id: Schema.String }),
          )(
            owner.db.sqlite
              .prepare("SELECT goal_instance_id FROM workflow_goal_instances WHERE session_id = ?")
              .get(context.session.id),
          )).goal_instance_id;
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
                .run(
                  id,
                  "historical-sdk-only",
                  "0".repeat(64),
                  "file:///tmp/old-worker.mjs",
                  "test",
                );
              break;
          }
          const acquire = Effect.scoped(
            makeOwnerNativeArtifacts({
              ...owner.db,
              directory: join(owner.storage.path, "native-artifacts"),
            }).acquire(id),
          );
          yield* sdkCall(() =>
            expect(runNative(acquire)).rejects.toMatchObject({
              _tag: "NativeRegistrationError",
            }),
          );
        }
      }),
    ),
  );
}

const sdkCall = Effect.fn("OwnerNativeTest.sdkCall")(<A>(call: () => A | PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);
const fixture = Effect.fn("OwnerNativeTest.fixture")(() =>
  Effect.acquireRelease(
    sdkCall(() => testRuntime()),
    (context) => sdkCall(() => context.runtime.dispose()).pipe(Effect.orDie),
  ),
);
