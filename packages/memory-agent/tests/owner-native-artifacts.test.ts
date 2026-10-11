import { fileURLToPath, pathToFileURL } from "node:url";
import { layer } from "@effect/vitest";
import { NodeServices, NodeCrypto } from "@effect/platform-node";
import { Hex } from "effect/encoding";
import { Cause, Effect, Layer, Schema, FileSystem, Path, Crypto } from "effect";
import { expect } from "vite-plus/test";
import {
  OwnerNativeArtifacts,
  makeOwnerNativeArtifacts,
} from "../src/agent/owner-native-artifacts.ts";
import { OwnerNativeBuild } from "../src/agent/owner-native-build.ts";
import { StorageRoot } from "../src/config/storage-root.ts";
import { Database } from "../src/db/database.ts";
import { runtimeArtifact } from "../src/runtime/resources.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { withTestPlatform } from "./support/platform.ts";
import { testRuntime } from "./support/runtime.ts";

layer(Layer.merge(NodeServices.layer, NodeCrypto.layer))((it) => {
  it.effect("missing prebuilt manifest is a typed service-startup failure", () =>
    withTestPlatform(
      Effect.gen(function* () {
        const context = yield* fixture();
        const services = yield* context.runtime.contextEffect;
        const failure = yield* Effect.provideContext(
          Effect.scoped(
            Effect.flip(
              Layer.build(
                OwnerNativeArtifacts.layer.pipe(
                  Layer.provide(
                    Layer.succeed(OwnerNativeBuild, {
                      manifest: "/missing/artifact-manifest.json",
                    }),
                  ),
                ),
              ),
            ),
          ),
          services,
        );
        expect(failure).toMatchObject({ _tag: "NativeRegistrationError" });
      }),
    ),
  );

  it.effect(
    "registers only the deterministic prebuilt artifact and revalidates it on cold acquisition",
    () =>
      withTestPlatform(
        Effect.gen(function* () {
          const context = yield* fixture();
          const services = yield* context.runtime.contextEffect;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const owner = yield* Effect.provideContext(
            Effect.all({ db: Database, workflows: Workflows, storage: StorageRoot }),
            services,
          );
          const id = yield* goalId(owner, context.session.id, "Prebuilt native artifact").pipe(
            Effect.provideContext(services),
          );
          const crypto = yield* Crypto.Crypto;
          const prebuilt = path.join(owner.storage.path, "prebuilt-runtime");
          yield* fs.copy(path.dirname(runtimeArtifact("artifact-manifest.json")), prebuilt, {
            overwrite: true,
          });
          const manifest = path.join(prebuilt, "artifact-manifest.json");
          const artifacts = () =>
            makeOwnerNativeArtifacts({
              ...owner.db,
              directory: path.join(owner.storage.path, "native-artifacts"),
              manifest,
            });
          const acquire = () => Effect.scoped(artifacts().acquire(id));
          yield* Effect.provideContext(acquire(), services);
          const registered = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              artifact_url: Schema.String,
              artifact_hash: Schema.String,
              source_hash: Schema.String,
              contract_version: Schema.String,
            }),
          )(
            owner.db.sqlite
              .prepare("SELECT * FROM workflow_goal_native_artifacts WHERE goal_instance_id = ?")
              .get(id),
          );
          expect(registered.artifact_url).toBe(
            pathToFileURL(
              path.join(
                owner.storage.path,
                "native-artifacts",
                Hex.encode(yield* crypto.digest("SHA-256", new TextEncoder().encode(id))),
                registered.artifact_hash,
                "native.mjs",
              ),
            ).href,
          );
          expect(registered.artifact_hash).toHaveLength(64);
          expect(registered.source_hash).toHaveLength(64);
          expect(registered.contract_version).toBe("native-factories/v1");
          yield* Effect.provideContext(acquire(), services);

          const buildNative = path.join(prebuilt, "native.mjs");
          yield* fs.writeFileString(buildNative, "// corrupt replacement build\n");
          yield* Effect.provideContext(acquire(), services);

          const pinnedNative = fileURLToPath(registered.artifact_url);
          const original = yield* fs.readFile(pinnedNative);
          yield* fs.writeFileString(pinnedNative, "// corrupt durable pin\n");
          const corrupted = yield* Effect.provideContext(Effect.flip(acquire()), services);
          expect(corrupted).toMatchObject({ _tag: "NativeArtifactLoadError" });
          yield* fs.writeFile(pinnedNative, original);
          yield* Effect.provideContext(acquire(), services);
        }),
      ),
    60_000,
  );

  it.effect("rejects corrupt manifests, missing worker entries, and historical backfill", () =>
    withTestPlatform(
      Effect.gen(function* () {
        const context = yield* fixture();
        const services = yield* context.runtime.contextEffect;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const owner = yield* Effect.provideContext(
          Effect.all({ db: Database, workflows: Workflows, storage: StorageRoot }),
          services,
        );
        const root = path.join(owner.storage.path, "prebuilt-failures");
        yield* fs.makeDirectory(root);
        yield* fs.copy(path.dirname(runtimeArtifact("artifact-manifest.json")), root, {
          overwrite: true,
        });
        const manifest = path.join(root, "artifact-manifest.json");
        const fresh = yield* goalId(owner, context.session.id, "Reject corrupt build").pipe(
          Effect.provideContext(services),
        );
        const acquire = (goalInstanceId: string) =>
          Effect.scoped(
            makeOwnerNativeArtifacts({
              ...owner.db,
              directory: path.join(owner.storage.path, "native-artifacts"),
              manifest,
            }).acquire(goalInstanceId),
          );

        const worker = path.join(root, "full-loop-worker.mjs");
        yield* fs.remove(worker);
        expect(yield* Effect.provideContext(Effect.flip(acquire(fresh)), services)).toMatchObject({
          _tag: "NativeRegistrationError",
        });
        yield* fs.copy(
          path.join(
            path.dirname(runtimeArtifact("artifact-manifest.json")),
            "full-loop-worker.mjs",
          ),
          worker,
        );
        yield* fs.writeFileString(manifest, "{}\n");
        expect(yield* Effect.provideContext(Effect.flip(acquire(fresh)), services)).toMatchObject({
          _tag: "NativeRegistrationError",
        });
        yield* fs.copy(runtimeArtifact("artifact-manifest.json"), manifest);

        owner.db.sqlite
          .prepare("INSERT INTO workflow_goal_worker_generations VALUES (?, ?, ?, ?, ?)")
          .run(fresh, "historical-sdk-only", "0".repeat(64), "file:///tmp/old-worker.mjs", "test");
        const historic = yield* Effect.provideContext(Effect.flip(acquire(fresh)), services);
        expect(historic).toMatchObject({
          _tag: "NativeRegistrationError",
          cause: { message: "Historical Goal has no native provenance; backfill refused" },
        });
      }),
    ),
  );
});

const goalId = Effect.fn("OwnerNativeTest.goalId")(function* (
  owner: {
    workflows: Workflows["Service"];
    db: Database["Service"];
  },
  sessionId: string,
  statement: string,
) {
  yield* owner.workflows.updateGoal(sessionId, {
    statement,
    outcomes: ["Verified owner provenance"],
    constraints: [],
    nonGoals: [],
    assumptions: [],
    openQuestions: [],
    status: "active",
  });
  return (yield* Schema.decodeUnknownEffect(Schema.Struct({ goal_instance_id: Schema.String }))(
    owner.db.sqlite
      .prepare("SELECT goal_instance_id FROM workflow_goal_instances WHERE session_id = ?")
      .get(sessionId),
  )).goal_instance_id;
});

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
