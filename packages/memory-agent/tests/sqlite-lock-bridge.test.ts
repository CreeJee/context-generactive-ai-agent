import { NodeServices } from "@effect/platform-node";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
// A crashing native child must fail this test without crashing the Vitest pool itself.
import { Effect, Schema, Layer, Path, Stream, Context } from "effect";
import { expect, it } from "vite-plus/test";

const Result = Schema.Struct({
  status: Schema.Literal("passed"),
  reads: Schema.Int,
  writes: Schema.Int,
});

it(
  "Node owner and native readers share SQLite locking during repeated reader close",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const services = yield* Layer.build(NodeServices.layer);
          const spawner = Context.get(services, ChildProcessSpawner.ChildProcessSpawner);
          const fixture = yield* Context.get(services, Path.Path).fromFileUrl(
            new URL("./fixtures/sqlite-lock-process.ts", import.meta.url),
          );
          const handle = yield* spawner.spawn(
            ChildProcess.make(process.execPath, ["--experimental-strip-types", fixture]),
          );
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              Stream.runCollect(handle.stdout.pipe(Stream.decodeText())),
              Stream.runCollect(handle.stderr.pipe(Stream.decodeText())),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          ).pipe(Effect.timeout("20 seconds"));
          expect(exitCode, stderr.join("")).toBe(0);

          const result = yield* Schema.decodeEffect(Schema.fromJsonString(Result))(
            stdout.join("").trim(),
          );
          expect(result.reads).toBe(300);
          expect(result.writes).toBeGreaterThan(0);
        }),
      ),
    ),
  25_000,
);
