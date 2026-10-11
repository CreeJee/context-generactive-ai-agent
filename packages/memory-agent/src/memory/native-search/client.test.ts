import { withTestPlatform } from "../../../tests/support/platform.ts";
import { Deferred, Effect, Exit, Fiber, FileSystem } from "effect";
import { Worker } from "node:worker_threads";
import { NativeOwnerFailed, type OwnerCommand } from "./worker-protocol.ts";
import { expect, it, vi } from "vite-plus/test";
import { makeNativeOwner } from "./client.ts";

it("uses the actual additive native primitive for exact results, shared cancellation and admission budget", () =>
  Effect.runPromise(
    Effect.scoped(
      withTestPlatform(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "native-controlled-" });
          const owner = yield* makeNativeOwner(
            {
              kind: "setup",
              epoch: "controlled",
              dimensions: 384,
              bits: 4,
              cacheDirectory: directory,
            },
            new URL("./worker.ts", import.meta.url),
          );
          const query = new Float32Array(384);
          query[0] = 1;
          yield* owner.execute({
            kind: "add",
            epoch: owner.epoch,
            requestId: "seed",
            vectors: query,
            ids: ["1"],
          });
          const legacy = yield* owner.execute({
            kind: "vector-search",
            epoch: owner.epoch,
            requestId: "legacy",
            query,
            k: 1,
            allowedIds: ["1"],
          });
          const request = (id: string, budgetMs: number) =>
            owner.execute({
              kind: "vector-search-controlled",
              epoch: owner.epoch,
              requestId: id,
              query,
              k: 1,
              allowedIds: ["1"],
              budgetMs,
            });
          const result = yield* request("success", 2_000);
          expect(result).toMatchObject({ kind: "controlled-result", outcome: "success" });
          if (legacy.kind !== "vector-hits" || result.kind !== "controlled-result")
            return yield* NativeOwnerFailed.make({ reason: "invalid-input" });
          expect(result.ids).toEqual(legacy.ids);
          expect(result.scores).toEqual(legacy.scores);
          const dispatched = yield* Deferred.make<{ worker: Worker; command: OwnerCommand }>();
          // eslint-disable-next-line typescript/unbound-method -- Measurement gate restores the receiver explicitly with .call below.
          const originalPost = Worker.prototype.postMessage;
          const spy = yield* Effect.acquireRelease(
            Effect.sync(() =>
              vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
                this: Worker,
                command: OwnerCommand,
              ) {
                Deferred.doneUnsafe(dispatched, Exit.succeed({ worker: this, command }));
              }),
            ),
            (handle) => Effect.sync(() => handle.mockRestore()),
          );
          const pending = yield* Effect.forkScoped(request("cancelled", 2_000));
          const queued = yield* Deferred.await(dispatched);
          yield* owner.cancel("cancelled");
          spy.mockRestore();
          originalPost.call(queued.worker, queued.command);
          expect(yield* Fiber.join(pending)).toMatchObject({
            kind: "controlled-result",
            outcome: "cancelled",
            ids: [],
          });
          expect(yield* request("budget", 1)).toMatchObject({
            kind: "controlled-result",
            outcome: "budget-exceeded",
            ids: [],
          });
          expect(
            yield* owner.execute({ kind: "save", epoch: owner.epoch, requestId: "still-live" }),
          ).toMatchObject({ kind: "ack" });
        }),
      ),
    ),
  ));

it("times out the caller without pretending an active transport job has terminated", () =>
  Effect.runPromise(
    Effect.scoped(
      withTestPlatform(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "native-timeout-" });
          const owner = yield* makeNativeOwner(
            { kind: "setup", epoch: "timeout", dimensions: 8, bits: 4, cacheDirectory: directory },
            new URL("./worker.ts", import.meta.url),
          );
          const blocked = yield* Deferred.make<void>();
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              vi.spyOn(Worker.prototype, "postMessage").mockImplementation(() => {
                // Transport-only gate. No actual native CPU or cancellation guarantee is claimed.
                Deferred.doneUnsafe(blocked, Exit.void);
              }),
            ),
            (spy) => Effect.sync(() => spy.mockRestore()),
          );
          const job = yield* Effect.forkScoped(
            owner.execute({ kind: "validate", epoch: "timeout", requestId: "timed", ids: [] }),
          );
          yield* Deferred.await(blocked);
          expect(yield* Effect.flip(Fiber.join(job))).toMatchObject({ reason: "request-timeout" });
          expect(yield* owner.inspect).toMatchObject({ kind: "open", queued: 0, active: 1 });
          // The enclosing Scope still owns shutdown and actual native resource cleanup.
        }),
      ),
    ).pipe(Effect.timeout("5 seconds")),
  ));

it("bounds admission, removes interrupted queued waits, and settles every waiter on worker exit", () =>
  Effect.runPromise(
    Effect.scoped(
      withTestPlatform(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "native-queue-" });
          const owner = yield* makeNativeOwner(
            { kind: "setup", epoch: "queue", dimensions: 8, bits: 4, cacheDirectory: directory },
            new URL("./worker.ts", import.meta.url),
          );
          const blocked = yield* Deferred.make<Worker>();
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
                this: Worker,
                command: OwnerCommand,
              ) {
                if (command.kind === "validate") {
                  // Narrow SDK interception gate: do not post, retain the active slot until exit.
                  Deferred.doneUnsafe(blocked, Exit.succeed(this));
                  return;
                }
                throw NativeOwnerFailed.make({ reason: "invalid-input" });
              }),
            ),
            (spy) => Effect.sync(() => spy.mockRestore()),
          );
          const request = (id: string) =>
            owner.execute({ kind: "validate", epoch: "queue", requestId: id, ids: [] });
          const active = yield* Effect.forkScoped(request("active"));
          const worker = yield* Deferred.await(blocked);
          const waiting = yield* Effect.forEach(
            Array.from({ length: 31 }, (_, i) => String(i)),
            (id) => Effect.forkScoped(request(id)),
          );
          yield* owner.inspect.pipe(
            Effect.repeat({ until: (state) => state.kind === "open" && state.queued === 31 }),
          );
          expect(yield* Effect.flip(request("overflow"))).toMatchObject({ reason: "queue-full" });
          yield* Fiber.interrupt(waiting[0]!);
          expect(yield* owner.inspect).toMatchObject({ kind: "open", queued: 30, active: 1 });
          const replacement = yield* Effect.forkScoped(request("replacement"));
          yield* owner.inspect.pipe(
            Effect.repeat({ until: (state) => state.kind === "open" && state.queued === 31 }),
          );
          // An interrupted active caller is not evidence that its native job terminated.
          yield* Fiber.interrupt(active);
          expect(yield* owner.inspect).toMatchObject({ kind: "open", queued: 31, active: 1 });
          expect(yield* Effect.flip(request("still-full"))).toMatchObject({ reason: "queue-full" });
          yield* Effect.tryPromise({
            try: () => worker.terminate(),
            catch: () => NativeOwnerFailed.make({ reason: "worker-exit" }),
          }).pipe(Effect.orDie);
          const failures = yield* Effect.forEach(
            [...waiting.slice(1), replacement],
            (fiber) => Effect.flip(Fiber.join(fiber)),
            { concurrency: 32 },
          );
          expect(failures).toHaveLength(31);
          for (const error of failures) expect(error).toMatchObject({ reason: "worker-exit" });
        }),
      ),
    ).pipe(Effect.timeout("5 seconds")),
  ));

it("matches scoped host requests and releases its lease after owner shutdown", () =>
  Effect.runPromise(
    Effect.scoped(
      withTestPlatform(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "native-client-" });
          const workerFile = new URL("./worker.ts", import.meta.url);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const owner = yield* makeNativeOwner(
                {
                  kind: "setup",
                  epoch: "first",
                  dimensions: 8,
                  bits: 4,
                  cacheDirectory: directory,
                },
                workerFile,
              );
              expect(owner.threadId).toBeGreaterThan(0);
              expect(
                yield* owner.execute({
                  kind: "add",
                  epoch: "first",
                  requestId: "add",
                  ids: ["1"],
                  vectors: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]),
                }),
              ).toMatchObject({ kind: "ack", size: 1 });
              const wrongEpoch = yield* Effect.exit(
                owner.execute({ kind: "save", epoch: "wrong", requestId: "wrong" }),
              );
              expect(Exit.isFailure(wrongEpoch)).toBe(true);
              expect(
                yield* owner.execute({
                  kind: "vector-search",
                  epoch: "first",
                  requestId: "search",
                  query: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]),
                  k: 1,
                  allowedIds: ["1"],
                }),
              ).toMatchObject({ kind: "vector-hits", ids: ["1"] });
              expect(
                yield* owner.execute({ kind: "save", epoch: "first", requestId: "save" }),
              ).toMatchObject({ kind: "ack" });
            }),
          );
          const reopened = yield* makeNativeOwner(
            { kind: "setup", epoch: "second", dimensions: 8, bits: 4, cacheDirectory: directory },
            workerFile,
          );
          expect(reopened.initialSize).toBe(1);
        }),
      ),
    ),
  ));
