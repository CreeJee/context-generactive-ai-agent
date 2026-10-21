import { gatedTransport } from "../../../tests/support/native-owner.ts";
import { withTestPlatform } from "../../../tests/support/platform.ts";
import { Crypto, Deferred, Effect, Fiber, FileSystem } from "effect";
import { expect, it } from "vite-plus/test";
import { makeNativeOwner, OwnerInspection, type OwnerTransport } from "./client.ts";
import { OwnerCommand } from "./worker-protocol.ts";
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
                const posted = yield* Deferred.make<OwnerTransport>();
                const owner = yield* makeNativeOwner(
                  {
                    kind: "setup",
                    epoch: mode,
                    dimensions: 384,
                    bits: 4,
                    cacheDirectory: directory,
                  },
                  new URL("./worker.ts", import.meta.url),
                  // Gate transport, not native CPU. Lifetime/cleanup assertion only.
                  gatedTransport((command, transport) =>
                    OwnerCommand.guards["vector-search-controlled"](command) &&
                    command.requestId !== "bad"
                      ? Deferred.succeed(posted, transport).pipe(Effect.andThen(Effect.never))
                      : transport.send(command),
                  ),
                );
                const query = new Float32Array(384);
                query[0] = 1;
                const request = (id: string, allowedIds = ["1"]) =>
                  owner.execute(
                    OwnerCommand.cases["vector-search-controlled"].make({
                      epoch: owner.epoch,
                      requestId: id,
                      query,
                      k: 1,
                      allowedIds,
                      budgetMs: 2_000,
                    }),
                  );
                expect(yield* Effect.flip(request("bad", ["01"]))).toMatchObject({
                  reason: "invalid-input",
                });
                expect(SearchControl.count()).toBe(baseline);
                const active = yield* Effect.forkScoped(request("active"));
                const transport = yield* Deferred.await(posted);
                const queued = yield* Effect.forkScoped(request("queued"));
                yield* owner.inspect.pipe(
                  Effect.repeat({
                    until: (state) => OwnerInspection.$is("open")(state) && state.queued === 1,
                  }),
                );
                expect(SearchControl.count()).toBe(baseline + 2);
                yield* Fiber.interrupt(queued);
                expect(SearchControl.count()).toBe(baseline + 1);
                yield* Fiber.interrupt(active);
                expect(SearchControl.count()).toBe(baseline);
                expect(yield* owner.inspect).toEqual(
                  OwnerInspection.open({ active: 1, queued: 0 }),
                );
                const pending = yield* Effect.forkScoped(request("pending"));
                yield* owner.inspect.pipe(
                  Effect.repeat({
                    until: (state) => OwnerInspection.$is("open")(state) && state.queued === 1,
                  }),
                );
                expect(SearchControl.count()).toBe(baseline + 1);
                switch (mode) {
                  case "failure":
                    yield* transport.terminate;
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
