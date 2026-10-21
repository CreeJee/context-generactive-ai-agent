// Native workers exercise immutable pins; Effect services own filesystem corruption fixtures.
import { NodeWorker, NodeServices } from "@effect/platform-node";
import { MessageChannel, Worker } from "node:worker_threads";
import { Cause, Effect, Layer, Match, Schema, Stream, FileSystem, Path } from "effect";
import { RpcClient, RpcServer } from "effect/rpc";
import { layer } from "@effect/vitest";
import { expect } from "vite-plus/test";

import { layerMessagePortRpcServer } from "../src/agent/effect-rpc-message-port.ts";
import { encodeFullLoopValue } from "../src/agent/full-loop-codec.ts";
import {
  FullLoopOwnerReply,
  FullLoopOwnerRpcGroup,
  FullLoopRpcGroup,
} from "../src/agent/full-loop-effect-rpc.ts";
import {
  GoalWorkerAssetsReason,
  makeGoalWorkerAssetsRegistry,
} from "../src/agent/goal-worker-assets.ts";
import { runtimeArtifact } from "../src/runtime/resources.ts";

const boot = Effect.fn("bootGoalWorker")(
  function* (url: URL, presentedToken = "asset-token") {
    const capability = {
      sessionId: "asset-session",
      runId: "asset-run",
      goalInstanceId: "asset-goal",
      goalVersion: 1,
      planVersion: 1,
      workflowRevisionId: 1,
      generation: "asset-generation",
      token: "asset-token",
    };
    const { port1, port2 } = new MessageChannel();
    const ownerHandlers = FullLoopOwnerRpcGroup.toLayer({
      OwnerCall: (request) => {
        const output: Schema.Json = Match.value(request.operation).pipe(
          Match.when("modelOpen", () => ({ id: "asset-model" })),
          Match.when("modelNext", () => ({ done: true })),
          Match.when("strategy", () => false),
          Match.orElse(() => null),
        );
        return Effect.succeed(
          FullLoopOwnerReply.cases.succeeded.make({
            operationId: request.operationId,
            output: encodeFullLoopValue(output),
          }),
        );
      },
    });
    const ownerServer = RpcServer.layer(FullLoopOwnerRpcGroup, { concurrency: 1 }).pipe(
      Layer.provide(ownerHandlers),
      Layer.provide(layerMessagePortRpcServer(port1)),
    );
    yield* Effect.forkScoped(Layer.launch(ownerServer));
    let activeWorker: Worker | undefined;
    const workerLayer = NodeWorker.layer(() => {
      const worker = new Worker(url, { workerData: { capability } });
      activeWorker = worker;
      return worker;
    });
    const protocol = RpcClient.layerProtocolWorker({ size: 1, concurrency: 1 }).pipe(
      Layer.provide(workerLayer),
    );
    const protocolContext = yield* Layer.build(protocol);
    yield* Effect.addFinalizer(() =>
      activeWorker === undefined
        ? Effect.void
        : Effect.tryPromise(() => activeWorker!.terminate()).pipe(Effect.orDie),
    );
    const client = yield* RpcClient.make(FullLoopRpcGroup).pipe(Effect.provide(protocolContext));
    yield* Stream.runDrain(
      client.RunFullLoop(
        {
          capability: { ...capability, token: presentedToken },
          lastOperationId: 0,
          turn: { messages: [] },
          tools: [],
          middleware: [],
          adapter: { name: "test", model: "test" },
          ownerPort: port2,
        },
        { streamBufferSize: 0 },
      ),
    ).pipe(Effect.timeout("10 seconds"));
    return "rpc";
  },
  Effect.scoped,
  Effect.catchCause((cause) => {
    // SAFETY: test diagnostics unwrap the typed RPC worker error to expose its native cause.
    const error = Cause.squash(cause) as any;
    return Effect.succeed(String(error?.reason?.cause?.stack ?? error));
  }),
);

layer(NodeServices.layer)((it) => {
  it.effect(
    "build-time worker boots and cold adoption does not consult replacement build inputs",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goal-assets-runtime-" });
          const registry = yield* makeGoalWorkerAssetsRegistry({ temporaryDirectory: directory });
          const reopened = yield* makeGoalWorkerAssetsRegistry({
            temporaryDirectory: directory,
            artifactManifest: "/missing/replacement-manifest.json",
          });
          try {
            const assets = yield* registry.resolve("runtime-default-goal");
            expect(yield* boot(assets.workerUrl)).toBe("rpc");
            expect(yield* boot(assets.workerUrl, "forged-token")).toContain("unauthorized");
            yield* registry.dispose();
            const adopted = yield* reopened.adopt(assets);
            expect(yield* reopened.resolve(assets.goalInstanceId)).toBe(adopted);
            expect(yield* boot(adopted.workerUrl)).toBe("rpc");
            yield* Effect.flip(reopened.resolve("new-goal-with-missing-build"));
          } finally {
            yield* reopened.dispose({ remove: true });
            yield* registry.dispose({ remove: true });
          }
        }),
      ),
  );

  it.effect(
    "source pins distinguish Goals sharing build bytes and worker leases fence registry disposal",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goal-assets-hash-" });
        const registry = yield* makeGoalWorkerAssetsRegistry({ temporaryDirectory: directory });
        try {
          const [first, sameGoal] = yield* Effect.all(
            [registry.resolve("goal-a"), registry.resolve("goal-a")],
            { concurrency: "unbounded" },
          );
          expect(sameGoal).toBe(first);
          const secondGoal = yield* registry.resolve("goal-b");
          expect(first.sourceGeneration).toMatch(/^[a-f0-9]{64}$/);
          expect(secondGoal.sourceGeneration).not.toBe(first.sourceGeneration);
          expect(yield* fs.readFile(yield* path.fromFileUrl(secondGoal.workerUrl))).toEqual(
            yield* fs.readFile(yield* path.fromFileUrl(first.workerUrl)),
          );
          const lease = yield* registry.use(first);
          expect((yield* Effect.flip(registry.dispose())).reason).toEqual(
            GoalWorkerAssetsReason.cases.LeasesActive.make({}),
          );
          lease.release();
          lease.release();
          expect(yield* registry.resolve("goal-a")).toBe(first);
          expect((yield* Effect.flip(registry.use({ ...first }))).reason).toEqual(
            GoalWorkerAssetsReason.cases.Unregistered.make({}),
          );
        } finally {
          yield* registry.dispose({ remove: true });
        }
      }),
  );

  it.effect("a corrupt replacement build cannot replace an already pinned Goal", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goal-assets-corrupt-build-" });
      const build = path.join(directory, "build");
      yield* fs.copy(path.dirname(runtimeArtifact("artifact-manifest.json")), build, {
        overwrite: true,
      });
      const registry = yield* makeGoalWorkerAssetsRegistry({
        temporaryDirectory: directory,
        artifactManifest: path.join(build, "artifact-manifest.json"),
      });
      try {
        const pinned = yield* registry.resolve("pinned");
        yield* fs.writeFileString(path.join(build, "full-loop-worker.mjs"), "// corrupt\n");
        expect((yield* Effect.flip(registry.resolve("new-goal"))).reason).toEqual(
          GoalWorkerAssetsReason.cases.Integrity.make({ check: "worker_hash" }),
        );
        expect(yield* registry.resolve("pinned")).toBe(pinned);
        expect(yield* registry.verify(pinned)).toEqual(pinned);
      } finally {
        yield* registry.dispose({ remove: true });
      }
    }),
  );

  it.effect.each(["bytes", "missing", "manifest"])(
    "cold adoption rejects %s corruption without capturing replacement",
    (corruption) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const original = yield* makeGoalWorkerAssetsRegistry();
        const replacement = yield* makeGoalWorkerAssetsRegistry({
          artifactManifest: "/missing/replacement-manifest.json",
        });
        try {
          const asset = yield* original.resolve("g");
          const worker = yield* path.fromFileUrl(asset.workerUrl);
          const destination = path.dirname(worker);
          yield* original.dispose();
          if (corruption === "bytes") yield* fs.writeFileString(worker, "tampered");
          else if (corruption === "missing") yield* fs.remove(worker);
          else {
            const manifest = path.join(destination, "goal-assets-manifest.json");
            yield* fs.chmod(manifest, 0o600);
            yield* fs.writeFileString(manifest, "{}\n");
          }
          yield* Effect.flip(replacement.adopt(asset));
          yield* Effect.flip(replacement.verify(asset));
        } finally {
          yield* replacement.dispose({ remove: true });
          yield* original.dispose({ remove: true });
        }
      }),
  );
});
