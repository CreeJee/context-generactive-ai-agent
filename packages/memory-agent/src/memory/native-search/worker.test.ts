import { withTestPlatform } from "../../../tests/support/platform.ts";
/* eslint-disable anti-slop/no-unknown-parameters -- Test callbacks decode raw Node IPC messages with OwnerReply. */
import { Effect, FileSystem, Schema } from "effect";
import { Worker } from "node:worker_threads";
import { expect, it } from "vite-plus/test";
import { NativeOwnerFailed, OwnerReply } from "./worker-protocol.ts";

const receive = (worker: Worker, command?: import("./worker-protocol.ts").OwnerCommand) =>
  Effect.callback<unknown, NativeOwnerFailed>((resume) => {
    const message = (value: unknown) => resume(Effect.succeed(value));
    const error = () => resume(Effect.fail(NativeOwnerFailed.make({ reason: "worker-error" })));
    worker.once("message", message);
    worker.once("error", error);
    if (command !== undefined) worker.postMessage(command);
    return Effect.sync(() => {
      worker.off("message", message);
      worker.off("error", error);
    });
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(OwnerReply)));

const close = (worker: Worker) =>
  Effect.callback<void, NativeOwnerFailed>((resume) => {
    const message = (value: unknown) => {
      const decoded = Schema.decodeUnknownResult(OwnerReply)(value);
      switch (decoded._tag) {
        case "Success":
          expect(decoded.success.kind).toBe("closed");
          break;
        case "Failure":
          resume(Effect.fail(NativeOwnerFailed.make({ reason: "invalid-input" })));
          break;
      }
    };
    const exit = (code: number) =>
      resume(
        code === 0 ? Effect.void : Effect.fail(NativeOwnerFailed.make({ reason: "worker-exit" })),
      );
    worker.once("message", message);
    worker.once("exit", exit);
    worker.postMessage({ kind: "close", requestId: "close", epoch: "test" });
    return Effect.sync(() => {
      worker.off("message", message);
      worker.off("exit", exit);
    });
  });

it("owns the native index and lease in a real worker, persists, and releases on close", () =>
  Effect.runPromise(
    Effect.scoped(
      withTestPlatform(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "native-owner-" });
          const spawn = () =>
            Effect.acquireRelease(
              Effect.sync(
                () =>
                  new Worker(new URL("./worker.ts", import.meta.url), {
                    workerData: {
                      kind: "setup",
                      epoch: "test",
                      dimensions: 8,
                      bits: 4,
                      cacheDirectory: directory,
                    },
                  }),
              ),
              (worker) =>
                Effect.tryPromise({
                  try: () => worker.terminate(),
                  catch: () => NativeOwnerFailed.make({ reason: "worker-exit" }),
                }).pipe(Effect.orDie),
            );
          const first = yield* spawn();
          const ready = yield* receive(first);
          expect(ready.kind).toBe("ready");
          if (ready.kind === "ready") {
            expect(ready.threadId).toBeGreaterThan(0);
            expect(ready.size).toBe(0);
          }
          const competing = yield* spawn();
          expect(yield* receive(competing)).toMatchObject({
            kind: "failed",
            code: "lease-unavailable",
          });
          expect(
            yield* receive(first, {
              kind: "add",
              requestId: "add",
              epoch: "test",
              ids: ["1"],
              vectors: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]),
            }),
          ).toMatchObject({ kind: "ack", size: 1 });
          expect(
            yield* receive(first, {
              kind: "vector-search",
              requestId: "search",
              epoch: "test",
              query: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]),
              k: 1,
              allowedIds: ["1"],
            }),
          ).toMatchObject({ kind: "vector-hits", ids: ["1"] });
          expect(
            yield* receive(first, { kind: "save", requestId: "save", epoch: "test" }),
          ).toMatchObject({ kind: "ack", size: 1 });
          yield* close(first);
          const reopened = yield* spawn();
          expect(yield* receive(reopened)).toMatchObject({ kind: "ready", size: 1 });
          yield* close(reopened);
        }),
      ),
    ),
  ));
