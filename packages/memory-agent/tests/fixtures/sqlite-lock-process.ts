import { Effect } from "effect";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createReadFixture } from "../../src/memory/native-search/read-fixture.ts";
import { initializeNodeSqlite } from "../../src/runtime/node-sqlite-bridge.ts";
import { requireRuntime } from "../../src/runtime/resources.ts";
import { NodeServices } from "@effect/platform-node";
import { Context, FileSystem, Layer, Schema } from "effect";
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const platform = yield* Layer.build(NodeServices.layer);
      const fs = Context.get(platform, FileSystem.FileSystem);

      // Isolated crash regression: no provider, account, user storage, or network.

      if (!isMainThread) {
        const path = String(workerData);
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
        for (let i = 0; i < 300; i++) {
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
        parentPort!.postMessage("completed");
      } else {
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "context-sqlite-regression-",
        });
        const path = `${directory}/owner.db`;
        const writer = createReadFixture(path);
        // Establish the owner's WAL SHM mapping before the other thread opens its first reader.
        writer.prepare("SELECT count(*) FROM nodes").get();
        const worker = new Worker(new URL(import.meta.url), { workerData: path });
        let completed = false;
        let failure: { readonly cause: unknown } | undefined;
        worker.on("message", () => {
          completed = true;
        });
        worker.on("error", (error) => {
          failure = { cause: error };
        });
        let writes = 0;
        try {
          while (!completed && failure === undefined) {
            writer.exec(`BEGIN; UPDATE nodes SET text = 'write-${writes}' WHERE seq = 1; COMMIT;`);
            writes++;
            yield* Effect.callback<void>((resume) => {
              const immediate = setImmediate(() => resume(Effect.void));
              return Effect.sync(() => clearImmediate(immediate));
            });
          }
          if (failure !== undefined) throw new Error("Native reader worker failed", failure);
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
          )({ status: "passed", reads: 300, writes });
          process.stdout.write(report + "\n");
        } finally {
          yield* Effect.uninterruptible(Effect.tryPromise(() => worker.terminate()));
          writer.close();
        }
      }
    }),
  ),
);
