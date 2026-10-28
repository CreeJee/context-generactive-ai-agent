import { NodeServices } from "@effect/platform-node";
import { Context, Deferred, Effect, Fiber, FileSystem, Layer, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect } from "vite-plus/test";
// Native child-process fixture: real SQLite locks coordinate two independent startup owners.
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "../../src/db/database.ts";
import { migrations } from "../../src/db/migrations.ts";

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      switch (process.argv[2]) {
        case "child": {
          const sqlite = new DatabaseSync(process.argv[3]!);
          try {
            sqlite.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
            process.stdout.write("ready\n");
            yield* migrateDatabase(sqlite);
            expect(sqlite.prepare("PRAGMA user_version").get()?.user_version).toBe(
              migrations.length,
            );
          } finally {
            sqlite.close();
          }
          break;
        }
        case "parent": {
          const platform = yield* Layer.build(NodeServices.layer);
          const fs = Context.get(platform, FileSystem.FileSystem);
          const path = Context.get(platform, Path.Path);
          const spawner = Context.get(platform, ChildProcessSpawner.ChildProcessSpawner);
          const script = yield* path.fromFileUrl(new URL(import.meta.url));
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "db-migration-race-" });
          const file = path.join(directory, "agent.db");
          const sqlite = new DatabaseSync(file);
          try {
            migrations.slice(0, 48).forEach((step) => sqlite.exec(step));
            sqlite.exec("PRAGMA user_version=48; BEGIN IMMEDIATE");
            const starts = yield* Effect.forEach(
              [0, 1],
              Effect.fnUntraced(function* () {
                const child = yield* spawner.spawn(
                  ChildProcess.make(process.execPath, [script, "child", file], {
                    stdin: "ignore",
                    killSignal: "SIGKILL",
                  }),
                );
                const ready = yield* Deferred.make<void>();
                yield* child.stdout.pipe(
                  Stream.decodeText(),
                  Stream.scan(
                    () => "",
                    (output, chunk) => output + chunk,
                  ),
                  Stream.runForEach((output) =>
                    output === "ready\n" ? Deferred.succeed(ready, undefined) : Effect.void,
                  ),
                  Effect.forkScoped,
                );
                const errors = yield* child.stderr.pipe(
                  Stream.decodeText(),
                  Stream.mkString,
                  Effect.forkScoped,
                );
                const exit = yield* Effect.gen(function* () {
                  const code = yield* child.exitCode;
                  const stderr = yield* Fiber.join(errors);
                  expect(code, stderr).toBe(0);
                }).pipe(Effect.forkScoped);
                return { ready, exit };
              }),
            );
            yield* Effect.forEach(starts, (start) => Deferred.await(start.ready));
            // Both children encounter the held migration lock before it is released.
            yield* Effect.sleep("100 millis");
            sqlite.exec("COMMIT");
            yield* Effect.forEach(starts, (start) => Fiber.join(start.exit));
            expect(sqlite.prepare("PRAGMA user_version").get()?.user_version).toBe(
              migrations.length,
            );
            expect(sqlite.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
            process.stdout.write("passed\n");
          } finally {
            sqlite.close();
          }
          break;
        }
        default:
          throw new Error("Expected parent or child fixture mode");
      }
    }),
  ),
);
