import { withTestPlatform } from "../../../tests/support/platform.ts";
import { Effect, FileSystem, Path } from "effect";
import { expect, it } from "vite-plus/test";
import { loadTurbovec } from "../../../../turbovec/index.js";
import { makeNativeOwner, ReadAdmission } from "./client.ts";
import { makePublication } from "./publication.ts";
import { createApplicationReadFixture } from "./read-fixture.ts";
import type { NativeReadInput } from "./read-protocol.ts";
import { NativeOwnerFailed, OwnerCommand, OwnerReply } from "./worker-protocol.ts";

it("settles scoped admission on real pin or terminal result and propagates pre-admission rejection", () =>
  Effect.runPromise(
    Effect.scoped(
      withTestPlatform(
        Effect.gen(function* () {
          const baseline = loadTurbovec().SearchControl.count();
          const fs = yield* FileSystem.FileSystem;
          const paths = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "admission-" });
          const databasePath = paths.join(directory, "fixture.sqlite");
          const db = yield* Effect.acquireRelease(
            createApplicationReadFixture(databasePath).pipe(
              Effect.mapError(() => NativeOwnerFailed.make({ reason: "read-failed" })),
            ),
            (value) => Effect.sync(() => value.close()),
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const owner = yield* makeNativeOwner(
                {
                  kind: "setup",
                  epoch: "admission",
                  dimensions: 384,
                  bits: 4,
                  cacheDirectory: paths.join(directory, "vector"),
                  databasePath,
                },
                new URL("./worker.ts", import.meta.url),
              );
              const input: NativeReadInput = {
                allowedProjects: ["allowed"],
                embedder: "fixture",
                trigramTerms: [],
                shortTerms: [],
                morphTerms: [],
                vectorK: 1,
                textK: 1,
                morphK: 1,
                textEnabled: false,
                morphEnabled: false,
                remainingMs: 2_000,
                inputBudgetBytes: 65_536,
                outputBudgetBytes: 4_096,
              };
              const seeded = new Float32Array(3 * 384);
              seeded[0] = 1;
              seeded[384] = 1;
              seeded[768] = 1;
              yield* owner.execute(
                OwnerCommand.cases.add.make({
                  epoch: owner.epoch,
                  requestId: "seed",
                  vectors: seeded,
                  ids: ["1", "2", "3"],
                }),
              );
              const publication = yield* makePublication(owner.epoch);
              const read = yield* publication.read(() =>
                owner.startRead(
                  OwnerCommand.cases["memory-search"].make({
                    epoch: owner.epoch,
                    requestId: "read",
                    input,
                  }),
                ),
              );
              expect(read.publication).toEqual({ epoch: owner.epoch, generation: 0 });
              ReadAdmission.$match(read.admission, {
                // Historical pin observation; actual result still owns termination.
                pinned: () => undefined,
                completed: (admission) => {
                  expect(OwnerReply.guards["memory-result"](admission.reply)).toBe(true);
                  expect(admission.reply).toMatchObject({ result: { kind: "success" } });
                },
              });
              expect(OwnerReply.guards["memory-result"](read.result)).toBe(true);
              expect(read.result).toMatchObject({ result: { kind: "success" } });
              expect(read.result).toMatchObject({ result: { unindexed: 2 } });
              const added = new Float32Array(384);
              added[0] = 1;
              yield* publication.withMutation(
                Effect.gen(function* () {
                  yield* owner.execute(
                    OwnerCommand.cases.add.make({
                      epoch: owner.epoch,
                      requestId: "publish-add",
                      vectors: added,
                      ids: ["6"],
                    }),
                  );
                  yield* owner.execute(
                    OwnerCommand.cases.save.make({
                      epoch: owner.epoch,
                      requestId: "publish-save",
                    }),
                  );
                  yield* Effect.try({
                    try: () => {
                      db.exec("BEGIN IMMEDIATE");
                      try {
                        db.prepare("INSERT INTO node_vectors VALUES (?,?)").run(6, "fixture");
                        db.exec("COMMIT");
                      } finally {
                        if (db.isTransaction) db.exec("ROLLBACK");
                      }
                    },
                    catch: () => NativeOwnerFailed.make({ reason: "read-failed" }),
                  });
                }),
              );
              const published = yield* publication.read(() =>
                owner.startRead(
                  OwnerCommand.cases["memory-search"].make({
                    epoch: owner.epoch,
                    requestId: "published",
                    input,
                  }),
                ),
              );
              expect(published.publication).toEqual({ epoch: owner.epoch, generation: 1 });
              expect(OwnerReply.guards["memory-result"](published.result)).toBe(true);
              expect(published.result).toMatchObject({
                result: { kind: "success", unindexed: 1 },
              });
              const mapped = yield* owner.execute(
                OwnerCommand.cases.validate.make({
                  epoch: owner.epoch,
                  requestId: "mapping",
                  ids: ["1", "2", "3", "6"],
                }),
              );
              expect(mapped).toEqual(
                OwnerReply.cases.ack.make({ epoch: owner.epoch, requestId: "mapping", size: 4 }),
              );
              const rejected = yield* owner.startRead(
                OwnerCommand.cases["memory-search"].make({
                  epoch: owner.epoch,
                  requestId: "invalid",
                  input: { ...input, inputBudgetBytes: 0 },
                }),
              );
              expect(yield* Effect.flip(rejected.admission)).toMatchObject({
                reason: "input-budget",
              });
              expect(yield* Effect.flip(rejected.result)).toMatchObject({ reason: "input-budget" });
            }),
          );
          expect(loadTurbovec().SearchControl.count()).toBe(baseline);
        }),
      ),
    ).pipe(Effect.timeout("5 seconds")),
  ));
