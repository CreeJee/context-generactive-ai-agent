import { withTestPlatform } from "../../../tests/support/platform.ts";
import { Crypto, Deferred, Effect, Exit, Fiber, FileSystem } from "effect";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vite-plus/test";
import { makeNativeOwner } from "./client.ts";
import { NativeOwnerFailed, type OwnerCommand } from "./worker-protocol.ts";
import { loadTurbovec } from "../../../../turbovec/index.js";

it("binds one-shot native control, rejects snapshot duplicates, and never recycles issued tokens", () =>
  Effect.runPromise(
    Effect.scoped(
      withTestPlatform(
        Effect.gen(function* () {
          const crypto = yield* Crypto.Crypto;
          const { SearchControl, VectorIndex } = loadTurbovec();
          const baseline = SearchControl.count();
          const index = new VectorIndex(384, 4);
          const vectors = new Float32Array(768);
          vectors[0] = 1;
          vectors[385] = 1;
          index.add(vectors, ["1", "2"]);
          expect(() => index.validateIds(["1", "1"])).toThrow();
          expect(() => index.validateIds(["01", "2"])).toThrow();
          index.validateIds(["2", "1"]);
          const seed = yield* crypto.randomUUIDv4();
          const owner = yield* crypto.randomUUIDv4();
          const control = new SearchControl(seed, owner, "epoch", "request", 2_000);
          const token = control.token();
          const query = vectors.slice(0, 384);
          try {
            expect(() => new SearchControl(seed, "other", "epoch", "request", 2_000)).toThrow();
            expect(
              index.searchControlled(query, 1, token, "other", "epoch", "request", ["1"]).kind,
            ).toBe("invalid-input");
            expect(
              index.searchControlled(query, 1, token, owner, "other", "request", ["1"]).kind,
            ).toBe("invalid-input");
            expect(
              index.searchControlled(query, 1, token, owner, "epoch", "other", ["1"]).kind,
            ).toBe("invalid-input");
            expect(
              index.searchControlled(query, 1, token, owner, "epoch", "request", ["1"]).kind,
            ).toBe("success");
            expect(
              index.searchControlled(query, 1, token, owner, "epoch", "request", ["1"]).kind,
            ).toBe("invalid-input");
          } finally {
            control.close();
          }
          const newer = new SearchControl(seed, owner, "epoch", "request", 2_000);
          try {
            expect(newer.token()).not.toBe(token);
            control.cancel();
            control.close();
            expect(
              index.searchControlled(query, 1, token, owner, "epoch", "request", ["1"]).kind,
            ).toBe("invalid-input");
            expect(
              index.searchControlled(query, 1, newer.token(), owner, "epoch", "request", ["1"])
                .kind,
            ).toBe("success");
          } finally {
            newer.close();
          }
          expect(SearchControl.count()).toBe(baseline);
        }),
      ),
    ),
  ));

it("closes native controls on rejected input, queued/active interruption, worker failure and Scope shutdown", () =>
  Effect.runPromise(
    Effect.scoped(
      withTestPlatform(
        Effect.gen(function* () {
          const { SearchControl } = loadTurbovec();
          const baseline = SearchControl.count();
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "control-life-" });
          for (const mode of ["failure", "shutdown"] as const) {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const owner = yield* makeNativeOwner(
                  {
                    kind: "setup",
                    epoch: mode,
                    dimensions: 384,
                    bits: 4,
                    cacheDirectory: directory,
                  },
                  new URL("./worker.ts", import.meta.url),
                );
                const query = new Float32Array(384);
                query[0] = 1;
                const request = (id: string, allowedIds = ["1"]) =>
                  owner.execute({
                    kind: "vector-search-controlled",
                    epoch: owner.epoch,
                    requestId: id,
                    query,
                    k: 1,
                    allowedIds,
                    budgetMs: 2_000,
                  });
                expect(yield* Effect.flip(request("bad", ["01"]))).toMatchObject({
                  reason: "invalid-input",
                });
                expect(SearchControl.count()).toBe(baseline);
                const posted = yield* Deferred.make<Worker>();
                yield* Effect.acquireRelease(
                  Effect.sync(() =>
                    vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
                      this: Worker,
                      command: OwnerCommand,
                    ) {
                      if (command.kind !== "vector-search-controlled")
                        throw NativeOwnerFailed.make({ reason: "invalid-input" });
                      // Gate transport, not native CPU. Lifetime/cleanup assertion only.
                      Deferred.doneUnsafe(posted, Exit.succeed(this));
                    }),
                  ),
                  (spy) => Effect.sync(() => spy.mockRestore()),
                );
                const active = yield* Effect.forkScoped(request("active"));
                const worker = yield* Deferred.await(posted);
                const queued = yield* Effect.forkScoped(request("queued"));
                yield* owner.inspect.pipe(
                  Effect.repeat({ until: (state) => state.kind === "open" && state.queued === 1 }),
                );
                expect(SearchControl.count()).toBe(baseline + 2);
                yield* Fiber.interrupt(queued);
                expect(SearchControl.count()).toBe(baseline + 1);
                yield* Fiber.interrupt(active);
                expect(SearchControl.count()).toBe(baseline);
                expect(yield* owner.inspect).toMatchObject({ kind: "open", active: 1, queued: 0 });
                const pending = yield* Effect.forkScoped(request("pending"));
                yield* owner.inspect.pipe(
                  Effect.repeat({ until: (state) => state.kind === "open" && state.queued === 1 }),
                );
                expect(SearchControl.count()).toBe(baseline + 1);
                switch (mode) {
                  case "failure":
                    yield* Effect.tryPromise({
                      try: () => worker.terminate(),
                      catch: () => NativeOwnerFailed.make({ reason: "worker-exit" }),
                    });
                    expect(yield* Effect.flip(Fiber.join(pending))).toMatchObject({
                      reason: "worker-exit",
                    });
                    expect(SearchControl.count()).toBe(baseline);
                    break;
                  case "shutdown":
                    break; // Scope owns the remaining queued control and worker.
                }
              }),
            );
            expect(SearchControl.count()).toBe(baseline);
          }
        }),
      ),
    ).pipe(Effect.timeout("5 seconds")),
  ));
