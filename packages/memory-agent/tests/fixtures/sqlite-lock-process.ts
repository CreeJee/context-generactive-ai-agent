import { NodeServices, NodeWorker, NodeWorkerRunner } from "@effect/platform-node";
import { Context, Effect, FileSystem, Layer, Schema } from "effect";
import { Rpc, RpcClient, RpcGroup, RpcServer } from "effect/rpc";
import { Worker, isMainThread } from "node:worker_threads";
import { createReadFixture } from "../../src/memory/native-search/read-fixture.ts";
import { runNativeEffect } from "../../src/runtime/native-effect.ts";
import { initializeNodeSqlite } from "../../src/runtime/node-sqlite-bridge.ts";
import { requireRuntime } from "../../src/runtime/resources.ts";

// Isolated crash regression: no provider, account, user storage, or network.

const reads = 300;
const Reader = RpcGroup.make(
  Rpc.make("ReadRepeatedly", { payload: { path: Schema.String }, success: Schema.Int }),
);

if (!isMainThread) {
  const handlers = Reader.toLayer({
    ReadRepeatedly: ({ path }) =>
      Effect.gen(function* () {
        const addon = requireRuntime("turbovec");
        const binding = addon.loadTurbovec();
        // Initialization is required before any native SQLite call and may be repeated safely.
        const refusedBeforeInitialization = yield* Effect.try(
          () => new binding.MemoryReadSession(path),
        ).pipe(Effect.match({ onFailure: () => true, onSuccess: () => false }));
        if (!refusedBeforeInitialization) throw new Error("Uninitialized SQLite must fail closed");
        initializeNodeSqlite(addon.addonPath);
        initializeNodeSqlite(addon.addonPath);
        const index = new binding.VectorIndex(384, 4);
        for (let i = 0; i < reads; i++) {
          const reader = new binding.MemoryReadSession(path);
          const control = new binding.SearchControl(`lock-${i}`, "lock", "lock", String(i), 5_000);
          try {
            const result = reader.search(
              index,
              {
                allowedProjects: ["allowed"],
                embedder: "fixture",
                trigramTerms: [],
                shortTerms: [],
                morphTerms: [],
                vectorK: 2,
                textK: 2,
                morphK: 2,
                textEnabled: false,
                morphEnabled: false,
                remainingMs: 5_000,
                inputBudgetBytes: 1_048_576,
                outputBudgetBytes: 1_048_576,
              },
              control.token(),
              "lock",
              "lock",
              String(i),
            );
            if (result.kind !== "success") throw new Error(`Native read failed: ${result.kind}`);
          } finally {
            reader.close();
            control.close();
          }
        }
        return reads;
      }),
  });
  const protocol = RpcServer.layerProtocolWorkerRunner.pipe(Layer.provide(NodeWorkerRunner.layer));
  await runNativeEffect(
    Layer.launch(RpcServer.layer(Reader).pipe(Layer.provide(handlers), Layer.provide(protocol))),
  );
} else {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const platform = yield* Layer.build(NodeServices.layer);
        const fs = Context.get(platform, FileSystem.FileSystem);
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "context-sqlite-regression-",
        });
        const path = `${directory}/owner.db`;
        const writer = createReadFixture(path);
        yield* Effect.addFinalizer(() => Effect.sync(() => writer.close()));
        // Establish the owner's WAL SHM mapping before the other thread opens its first reader.
        writer.prepare("SELECT count(*) FROM nodes").get();
        const protocol = yield* Layer.build(
          RpcClient.layerProtocolWorker({ size: 1, concurrency: 1 }).pipe(
            Layer.provide(NodeWorker.layer(() => new Worker(new URL(import.meta.url)))),
          ),
        );
        const client = yield* RpcClient.make(Reader).pipe(Effect.provide(protocol));
        let writes = 0;
        const write = Effect.sync(() => {
          writer.exec(`BEGIN; UPDATE nodes SET text = 'write-${writes}' WHERE seq = 1; COMMIT;`);
          writes++;
        }).pipe(
          Effect.andThen(
            Effect.callback<void>((resume) => {
              const immediate = setImmediate(() => resume(Effect.void));
              return Effect.sync(() => clearImmediate(immediate));
            }),
          ),
        );
        // Keep writing until the reader thread finishes; its failure fails the race.
        const completed = yield* client
          .ReadRepeatedly({ path })
          .pipe(Effect.raceFirst(Effect.forever(write)));
        const integrity = writer.prepare("PRAGMA integrity_check").get();
        if (integrity?.integrity_check !== "ok") throw new Error("SQLite integrity failed");
        const report = yield* Schema.encodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              status: Schema.Literal("passed"),
              reads: Schema.Int,
              writes: Schema.Int,
            }),
          ),
        )({ status: "passed", reads: completed, writes });
        process.stdout.write(report + "\n");
      }),
    ),
  );
}
