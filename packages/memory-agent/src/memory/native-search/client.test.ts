import { withTestPlatform } from "../../../tests/support/platform.ts";
import { gatedTransport } from "../../../tests/support/native-owner.ts";
import { Deferred, Effect, Exit, Fiber, FileSystem } from "effect";
import { NativeOwnerFailed, OwnerCommand, OwnerReply } from "./worker-protocol.ts";
import { expect, it } from "vite-plus/test";
import { makeNativeOwner, OwnerInspection, type OwnerTransport } from "./client.ts";

it("uses the actual additive native primitive for exact results, shared cancellation and admission budget", () =>
  Effect.runPromise(
    Effect.scoped(
      withTestPlatform(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "native-controlled-" });
          const dispatched = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const owner = yield* makeNativeOwner(
            {
              kind: "setup",
              epoch: "controlled",
              dimensions: 384,
              bits: 4,
              cacheDirectory: directory,
            },
            new URL("./worker.ts", import.meta.url),
            // Holds the "cancelled" request in transport until the test has cancelled it.
            gatedTransport((command, transport) =>
              command.requestId === "cancelled"
                ? Deferred.succeed(dispatched, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(transport.send(command)),
                  )
                : transport.send(command),
            ),
          );
          const query = new Float32Array(384);
          query[0] = 1;
          yield* owner.execute(
            OwnerCommand.cases.add.make({
              epoch: owner.epoch,
              requestId: "seed",
              vectors: query,
              ids: ["1"],
            }),
          );
          const legacy = yield* owner.execute(
            OwnerCommand.cases["vector-search"].make({
              epoch: owner.epoch,
              requestId: "legacy",
              query,
              k: 1,
              allowedIds: ["1"],
            }),
          );
          const request = (id: string, budgetMs: number) =>
            owner.execute(
              OwnerCommand.cases["vector-search-controlled"].make({
                epoch: owner.epoch,
                requestId: id,
                query,
                k: 1,
                allowedIds: ["1"],
                budgetMs,
              }),
            );
          const result = yield* request("success", 2_000);
          expect(result).toMatchObject({ outcome: "success" });
          if (
            !OwnerReply.guards["vector-hits"](legacy) ||
            !OwnerReply.guards["controlled-result"](result)
          )
            return yield* NativeOwnerFailed.make({ reason: "invalid-input" });
          expect(result.ids).toEqual(legacy.ids);
          expect(result.scores).toEqual(legacy.scores);
          const pending = yield* Effect.forkScoped(request("cancelled", 2_000));
          yield* Deferred.await(dispatched);
          yield* owner.cancel("cancelled");
          yield* Deferred.succeed(release, undefined);
          const cancelled = yield* Fiber.join(pending);
          expect(OwnerReply.guards["controlled-result"](cancelled)).toBe(true);
          expect(cancelled).toMatchObject({ outcome: "cancelled", ids: [] });
          const exceeded = yield* request("budget", 1);
          expect(OwnerReply.guards["controlled-result"](exceeded)).toBe(true);
          expect(exceeded).toMatchObject({ outcome: "budget-exceeded", ids: [] });
          expect(
            OwnerReply.guards.ack(
              yield* owner.execute(
                OwnerCommand.cases.save.make({ epoch: owner.epoch, requestId: "still-live" }),
              ),
            ),
          ).toBe(true);
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
          const blocked = yield* Deferred.make<void>();
          const owner = yield* makeNativeOwner(
            { kind: "setup", epoch: "timeout", dimensions: 8, bits: 4, cacheDirectory: directory },
            new URL("./worker.ts", import.meta.url),
            // Transport-only gate. No actual native CPU or cancellation guarantee is claimed.
            gatedTransport(() =>
              Deferred.succeed(blocked, undefined).pipe(Effect.andThen(Effect.never)),
            ),
          );
          const job = yield* Effect.forkScoped(
            owner.execute(
              OwnerCommand.cases.validate.make({ epoch: "timeout", requestId: "timed", ids: [] }),
            ),
          );
          yield* Deferred.await(blocked);
          expect(yield* Effect.flip(Fiber.join(job))).toMatchObject({ reason: "request-timeout" });
          expect(yield* owner.inspect).toEqual(OwnerInspection.open({ queued: 0, active: 1 }));
          // The enclosing Scope still owns shutdown and actual native resource cleanup.
        }),
      ),
    ).pipe(Effect.timeout("5 seconds")),
  ));

it("waits past a budgeted search's budget for its own budget-exceeded reply", () =>
  Effect.runPromise(
    Effect.scoped(
      withTestPlatform(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "native-late-" });
          const owner = yield* makeNativeOwner(
            { kind: "setup", epoch: "late", dimensions: 384, bits: 4, cacheDirectory: directory },
            new URL("./worker.ts", import.meta.url),
            // The reply reaches the host after the budget and after the plain 2 s reply timeout.
            gatedTransport((command, transport) =>
              Effect.sleep("2500 millis").pipe(Effect.andThen(transport.send(command))),
            ),
          );
          const late = yield* owner.execute(
            OwnerCommand.cases["vector-search-controlled"].make({
              epoch: owner.epoch,
              requestId: "late",
              query: new Float32Array(384).fill(1 / Math.sqrt(384)),
              k: 1,
              allowedIds: [],
              budgetMs: 2_000,
            }),
          );
          expect(OwnerReply.guards["controlled-result"](late)).toBe(true);
          expect(late).toMatchObject({ outcome: "budget-exceeded" });
        }),
      ),
    ).pipe(Effect.timeout("8 seconds")),
  ));

it("bounds admission, removes interrupted queued waits, and settles every waiter on worker exit", () =>
  Effect.runPromise(
    Effect.scoped(
      withTestPlatform(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "native-queue-" });
          const blocked = yield* Deferred.make<OwnerTransport>();
          const owner = yield* makeNativeOwner(
            { kind: "setup", epoch: "queue", dimensions: 8, bits: 4, cacheDirectory: directory },
            new URL("./worker.ts", import.meta.url),
            // Never sends: the first job keeps the active slot until the worker exits.
            gatedTransport((_, transport) =>
              Deferred.succeed(blocked, transport).pipe(Effect.andThen(Effect.never)),
            ),
          );
          const request = (id: string) =>
            owner.execute(
              OwnerCommand.cases.validate.make({ epoch: "queue", requestId: id, ids: [] }),
            );
          const active = yield* Effect.forkScoped(request("active"));
          const transport = yield* Deferred.await(blocked);
          const waiting = yield* Effect.forEach(
            Array.from({ length: 31 }, (_, i) => String(i)),
            (id) => Effect.forkScoped(request(id)),
          );
          yield* owner.inspect.pipe(
            Effect.repeat({
              until: (state) => OwnerInspection.$is("open")(state) && state.queued === 31,
            }),
          );
          expect(yield* Effect.flip(request("overflow"))).toMatchObject({ reason: "queue-full" });
          yield* Fiber.interrupt(waiting[0]!);
          expect(yield* owner.inspect).toEqual(OwnerInspection.open({ queued: 30, active: 1 }));
          const replacement = yield* Effect.forkScoped(request("replacement"));
          yield* owner.inspect.pipe(
            Effect.repeat({
              until: (state) => OwnerInspection.$is("open")(state) && state.queued === 31,
            }),
          );
          // An interrupted active caller is not evidence that its native job terminated.
          yield* Fiber.interrupt(active);
          expect(yield* owner.inspect).toEqual(OwnerInspection.open({ queued: 31, active: 1 }));
          expect(yield* Effect.flip(request("still-full"))).toMatchObject({ reason: "queue-full" });
          yield* transport.terminate;
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
                yield* owner.execute(
                  OwnerCommand.cases.add.make({
                    epoch: "first",
                    requestId: "add",
                    ids: ["1"],
                    vectors: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]),
                  }),
                ),
              ).toEqual(OwnerReply.cases.ack.make({ epoch: "first", requestId: "add", size: 1 }));
              const wrongEpoch = yield* Effect.exit(
                owner.execute(OwnerCommand.cases.save.make({ epoch: "wrong", requestId: "wrong" })),
              );
              expect(Exit.isFailure(wrongEpoch)).toBe(true);
              const hits = yield* owner.execute(
                OwnerCommand.cases["vector-search"].make({
                  epoch: "first",
                  requestId: "search",
                  query: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]),
                  k: 1,
                  allowedIds: ["1"],
                }),
              );
              expect(OwnerReply.guards["vector-hits"](hits)).toBe(true);
              expect(hits).toMatchObject({ ids: ["1"] });
              expect(
                OwnerReply.guards.ack(
                  yield* owner.execute(
                    OwnerCommand.cases.save.make({ epoch: "first", requestId: "save" }),
                  ),
                ),
              ).toBe(true);
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
