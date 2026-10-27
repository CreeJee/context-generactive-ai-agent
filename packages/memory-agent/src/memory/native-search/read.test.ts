import { withTestPlatform } from "../../../tests/support/platform.ts";
import { Effect, FileSystem, Path } from "effect";
import { expect, it } from "vite-plus/test";
import { makeNativeOwner, OwnerInspection } from "./client.ts";
import { NativeOwnerFailed, OwnerCommand, OwnerReply } from "./worker-protocol.ts";
import {
  createApplicationReadFixture,
  createReadFixture,
  legacyFixtureChannels,
} from "./read-fixture.ts";
import type { NativeReadInput } from "./read-protocol.ts";

it("refuses an unmigrated DB before cache writes or native reader initialization", () =>
  Effect.runPromise(
    Effect.scoped(
      withTestPlatform(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const paths = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "native-schema-" });
          const databasePath = paths.join(directory, "fixture.sqlite");
          const db = yield* Effect.acquireRelease(
            Effect.sync(() => createReadFixture(databasePath)),
            (connection) => Effect.sync(() => connection.close()),
          );
          const cacheDirectory = paths.join(directory, "vector");
          const failed = yield* Effect.flip(
            makeNativeOwner(
              {
                kind: "setup",
                epoch: "schema",
                dimensions: 384,
                bits: 4,
                cacheDirectory,
                databasePath,
              },
              new URL("./worker.ts", import.meta.url),
            ),
          );
          expect(failed.reason).toBe("native-incompatible");
          expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
          expect(yield* fs.exists(cacheDirectory)).toBe(false);
        }),
      ),
    ),
  ));

it(
  "returns scoped ordered channels/coverage with native candidates and one batch hit mapping",
  () =>
    Effect.runPromise(
      Effect.scoped(
        withTestPlatform(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const paths = yield* Path.Path;
            const directory = yield* fs.makeTempDirectoryScoped({ prefix: "native-read-" });
            const databasePath = paths.join(directory, "fixture.sqlite");
            const db = yield* Effect.acquireRelease(
              createApplicationReadFixture(databasePath),
              (connection) => Effect.sync(() => connection.close()),
            );
            const legacy = legacyFixtureChannels(db);
            const owner = yield* makeNativeOwner(
              {
                kind: "setup",
                epoch: "read",
                dimensions: 384,
                bits: 4,
                cacheDirectory: paths.join(directory, "vector"),
                databasePath,
              },
              new URL("./worker.ts", import.meta.url),
            );
            const query = new Float32Array(384);
            query[0] = 1;
            const matrix = new Float32Array(384 * 3);
            matrix.set(query, 0);
            matrix[384] = 0.8;
            matrix[385] = 0.6;
            matrix.set(query, 768);
            yield* owner.execute(
              OwnerCommand.cases.add.make({
                epoch: owner.epoch,
                requestId: "seed",
                vectors: matrix,
                ids: ["1", "2", "3"],
              }),
            );
            const oldVectors = yield* owner.execute(
              OwnerCommand.cases["vector-search"].make({
                epoch: owner.epoch,
                requestId: "old-vector",
                query,
                k: 2,
                allowedIds: ["1", "2"],
              }),
            );
            const input: NativeReadInput = {
              allowedProjects: ["allowed"],
              embedder: "fixture",
              query,
              trigramTerms: ["sqlite"],
              shortTerms: ["로그", "포맷"],
              morphTerms: ["로그", "포맷"],
              vectorK: 2,
              textK: 2,
              morphK: 2,
              textEnabled: true,
              morphEnabled: true,
              remainingMs: 2_000,
              inputBudgetBytes: 1_048_576,
              outputBudgetBytes: 1_048_576,
            };
            const search = (id: string, patch: Partial<NativeReadInput> = {}) =>
              owner.execute(
                OwnerCommand.cases["memory-search"].make({
                  epoch: owner.epoch,
                  requestId: id,
                  input: { ...input, ...patch },
                }),
              );
            const oversized = yield* Effect.flip(
              search("too-many-empty-terms", {
                shortTerms: Array.from({ length: 200_000 }, () => ""),
              }),
            );
            expect(oversized).toMatchObject({ reason: "input-budget" });
            // The preceding completed reply may still occupy its cleanup slot; the
            // rejected input must not add a queued request.
            const inspected = yield* owner.inspect;
            expect(OwnerInspection.$is("open")(inspected)).toBe(true);
            expect(inspected).toMatchObject({ queued: 0 });
            const reply = yield* search("scoped");
            expect(reply).toMatchObject({ result: { kind: "success" } });
            if (
              !OwnerReply.guards["memory-result"](reply) ||
              !OwnerReply.guards["vector-hits"](oldVectors)
            )
              return yield* NativeOwnerFailed.make({ reason: "invalid-input" });
            expect(reply.result.vectorUnavailable).toBe(false);
            expect(reply.result.vectorSeqs).toEqual(oldVectors.ids);
            expect(reply.result.vectorScores).toEqual(oldVectors.scores);
            expect(reply.result.vectorIds).toEqual(["alpha", "beta"]);
            expect(reply.result.candidateCount).toBe(2);
            expect(reply.result.textIds).toEqual(legacy.text);
            expect(reply.result.textIds.length).toBeGreaterThan(input.textK);
            expect(reply.result.morphIds).toEqual(legacy.morph);
            expect(reply.result.unindexed).toBe(legacy.unindexed);
            expect(reply.result.uninterpreted).toBe(legacy.uninterpreted);
            const one = yield* search("one", { vectorK: 1 });
            if (!OwnerReply.guards["memory-result"](one))
              return yield* NativeOwnerFailed.make({ reason: "invalid-input" });
            expect(one.result.vectorIds).toEqual(["alpha"]);
            expect(one.result.sqliteExecutions).toBe(reply.result.sqliteExecutions);
            // Growing candidates must not enlarge the request with an allowlist or add hit SELECTs.
            const extra = new Float32Array(384 * 50);
            const extraIds = Array.from({ length: 50 }, (_, row) => String(100 + row));
            for (let row = 0; row < 50; row++) {
              extra.set(query, row * 384);
              db.prepare(
                "INSERT INTO nodes(seq,id,kind,project_id,text,session_id,created_at) VALUES (?, ?, 'user', 'allowed', 'candidate only','allowed-session','fixture')",
              ).run(100 + row, `candidate-${row}`);
              db.prepare("INSERT INTO node_vectors VALUES (?, 'fixture')").run(100 + row);
            }
            yield* owner.execute(
              OwnerCommand.cases.add.make({
                epoch: owner.epoch,
                requestId: "grow",
                vectors: extra,
                ids: extraIds,
              }),
            );
            const grown = yield* search("grown");
            if (!OwnerReply.guards["memory-result"](grown))
              return yield* NativeOwnerFailed.make({ reason: "invalid-input" });
            expect(grown.result.kind).toBe("success");
            expect(grown.result.candidateCount).toBe(52);
            expect(grown.result.vectorIds.length).toBe(2);
            expect(grown.result.sqliteExecutions).toBe(reply.result.sqliteExecutions);
            expect(grown.result.outputLogicalBytes).toBeLessThan(512);
            expect(grown.result.inputLogicalBytes).toBe(reply.result.inputLogicalBytes);
            const expired = yield* search("expired", { remainingMs: 0 });
            expect(OwnerReply.guards["memory-result"](expired)).toBe(true);
            expect(expired).toMatchObject({
              result: {
                kind: "budget-exceeded",
                vectorUnavailable: false,
                vectorIds: [],
                textIds: [],
                morphIds: [],
                sqliteExecutions: 0,
              },
            });
            const empty = yield* search("empty", { allowedProjects: [] });
            expect(OwnerReply.guards["memory-result"](empty)).toBe(true);
            expect(empty).toMatchObject({
              result: {
                kind: "success",
                vectorIds: [],
                textIds: [],
                morphIds: [],
                uninterpreted: 0,
                unindexed: legacy.unindexed,
              },
            });
            const small = yield* search("output", { outputBudgetBytes: 1 });
            expect(OwnerReply.guards["memory-result"](small)).toBe(true);
            expect(small).toMatchObject({
              result: { kind: "budget-exceeded", vectorIds: [], textIds: [], morphIds: [] },
            });
          }),
        ),
      ),
    ),
  10_000,
);
