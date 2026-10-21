import { withTestPlatform } from "../../../tests/support/platform.ts";
import { Effect, FileSystem } from "effect";
import { expect, it } from "vite-plus/test";
import { rpcTransport } from "./client.ts";
import { OwnerCommand, OwnerReply, type OwnerSetup } from "./worker-protocol.ts";

it("owns the native index and lease in a real worker, persists, and releases on close", () =>
  Effect.runPromise(
    Effect.scoped(
      withTestPlatform(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "native-owner-" });
          const setup: OwnerSetup = {
            kind: "setup",
            epoch: "test",
            dimensions: 8,
            bits: 4,
            cacheDirectory: directory,
          };
          const workerFile = new URL("./worker.ts", import.meta.url);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const first = yield* rpcTransport({ setup, workerFile });
              expect(first.ready.threadId).toBeGreaterThan(0);
              expect(first.ready.size).toBe(0);
              expect(
                yield* Effect.flip(Effect.scoped(rpcTransport({ setup, workerFile }))),
              ).toMatchObject({ reason: "lease-unavailable" });
              expect(
                yield* first.send(
                  OwnerCommand.cases.add.make({
                    requestId: "add",
                    epoch: "test",
                    ids: ["1"],
                    vectors: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]),
                  }),
                ),
              ).toEqual(OwnerReply.cases.ack.make({ requestId: "add", epoch: "test", size: 1 }));
              const hits = yield* first.send(
                OwnerCommand.cases["vector-search"].make({
                  requestId: "search",
                  epoch: "test",
                  query: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]),
                  k: 1,
                  allowedIds: ["1"],
                }),
              );
              expect(OwnerReply.guards["vector-hits"](hits)).toBe(true);
              expect(hits).toMatchObject({ ids: ["1"] });
              expect(
                yield* first.send(
                  OwnerCommand.cases.save.make({ requestId: "save", epoch: "test" }),
                ),
              ).toEqual(OwnerReply.cases.ack.make({ requestId: "save", epoch: "test", size: 1 }));
            }),
          );
          const reopened = yield* rpcTransport({ setup, workerFile });
          expect(reopened.ready.size).toBe(1);
        }),
      ),
    ),
  ));
