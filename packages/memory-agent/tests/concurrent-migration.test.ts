import { NodeServices } from "@effect/platform-node";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Effect, Layer, Path, Stream, Context } from "effect";
import { expect, it } from "vite-plus/test";

it(
  "concurrent owners serialize migration and re-read the actual DB version under its lock",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const services = yield* Layer.build(NodeServices.layer);
          const spawner = Context.get(services, ChildProcessSpawner.ChildProcessSpawner);
          const fixture = yield* Context.get(services, Path.Path).fromFileUrl(
            new URL("./fixtures/concurrent-migration.ts", import.meta.url),
          );
          const handle = yield* spawner.spawn(
            ChildProcess.make(process.execPath, [fixture, "parent"]),
          );
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              Stream.runCollect(handle.stdout.pipe(Stream.decodeText())),
              Stream.runCollect(handle.stderr.pipe(Stream.decodeText())),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          ).pipe(Effect.timeout("15 seconds"));
          expect(exitCode, stderr.join("")).toBe(0);
          expect(stdout.join("").trim()).toBe("passed");
        }),
      ),
    ),
  20000,
);
