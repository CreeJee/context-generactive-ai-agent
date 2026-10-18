import { withTestPlatform } from "../../../tests/support/platform.ts";
import { Effect, FileSystem } from "effect";
import { expect, it } from "vite-plus/test";
import { rpcTransport } from "./client.ts";
import type { OwnerSetup } from "./worker-protocol.ts";

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
                yield* first.send({
                  kind: "add",
                  requestId: "add",
                  epoch: "test",
                  ids: ["1"],
                  vectors: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]),
                }),
              ).toMatchObject({ kind: "ack", size: 1 });
              expect(
                yield* first.send({
                  kind: "vector-search",
                  requestId: "search",
                  epoch: "test",
                  query: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]),
                  k: 1,
                  allowedIds: ["1"],
                }),
              ).toMatchObject({ kind: "vector-hits", ids: ["1"] });
              expect(
                yield* first.send({ kind: "save", requestId: "save", epoch: "test" }),
              ).toMatchObject({ kind: "ack", size: 1 });
            }),
          );
          const reopened = yield* rpcTransport({ setup, workerFile });
          expect(reopened.ready.size).toBe(1);
        }),
      ),
    ),
  ));
