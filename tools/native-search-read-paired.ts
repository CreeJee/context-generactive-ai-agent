// Finite boundary comparison using one owner/index and one temporary WAL fixture.
// Both arms use the same worker for vector scoring: NOT a full old-main-thread app benchmark.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Effect, Schema } from "effect";
import { NativeOwner } from "../packages/memory-agent/src/memory/native-search/client.ts";
import {
  createReadFixture,
  legacyFixtureChannels,
} from "../packages/memory-agent/src/memory/native-search/read-fixture.ts";
import { meaningfulNodeFilter } from "../packages/memory-agent/src/memory/quality.ts";
import type { NativeReadInput } from "../packages/memory-agent/src/memory/native-search/read-protocol.ts";

class PairedFailed extends Schema.TaggedError<PairedFailed>()("PairedFailed", {
  reason: Schema.Literals(["fixture", "reply", "quality"]),
}) {}
const dimensions = 384;
const extraCount = 10_000;
const input: NativeReadInput = {
  allowedProjects: ["allowed"],
  embedder: "fixture",
  query: new Float32Array(dimensions),
  trigramTerms: ["sqlite"],
  shortTerms: ["로그", "포맷"],
  morphTerms: ["로그", "포맷"],
  vectorK: 48,
  textK: 2,
  morphK: 2,
  textEnabled: true,
  morphEnabled: true,
  remainingMs: 2_000,
  inputBudgetBytes: 1_048_576,
  outputBudgetBytes: 16_384,
};
input.query![0] = 1;
const samples: {
  arm: "legacy-boundary" | "native-read";
  coldFirstCall: boolean;
  wallMs: number;
  mainCpuMs: number;
  workerBoundaryCpuMs: number;
  vectorWallMs: number;
  sqlCalls: number;
  candidateCount: number;
  inputLogicalBytes: number;
  outputLogicalBytes: number;
}[] = [];
const observe = Effect.scoped(
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.try({
        try: () => mkdtempSync(join(tmpdir(), "read-paired-")),
        catch: () => new PairedFailed({ reason: "fixture" }),
      }),
      (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
    );
    const databasePath = join(directory, "fixture.sqlite");
    const db = yield* Effect.acquireRelease(
      Effect.try({
        try: () => createReadFixture(databasePath),
        catch: () => new PairedFailed({ reason: "fixture" }),
      }),
      (value) => Effect.sync(() => value.close()),
    );
    const ids = [
      "1",
      "2",
      "3",
      ...Array.from({ length: extraCount }, (_, row) => String(row + 100)),
    ];
    const matrix = new Float32Array(ids.length * dimensions);
    for (let row = 0; row < ids.length; row++) {
      matrix[row * dimensions] = 0.8;
      matrix[row * dimensions + 1] = 0.6;
    }
    matrix.set(input.query!, 0);
    const node = db.prepare(
      "INSERT INTO nodes VALUES (?, ?, 'user', 'allowed', 'sqlite 로그 포맷')",
    );
    const vector = db.prepare("INSERT INTO node_vectors VALUES (?, 'fixture')");
    const text = db.prepare("INSERT INTO nodes_fts(rowid,text) VALUES (?, 'sqlite 로그 포맷')");
    const morph = db.prepare("INSERT INTO nodes_morph(rowid,terms) VALUES (?, '로그 포맷 메모리')");
    db.exec("BEGIN");
    for (let row = 0; row < extraCount; row++) {
      const seq = row + 100;
      node.run(seq, `generated-${seq}`);
      vector.run(seq);
      text.run(seq);
      morph.run(seq);
    }
    db.exec("COMMIT");
    return yield* Effect.gen(function* () {
      const owner = yield* NativeOwner;
      yield* owner.execute({
        kind: "add",
        epoch: owner.epoch,
        requestId: "seed",
        vectors: matrix,
        ids,
      });
      const old = Effect.fnUntraced(function* (round: number) {
        const start = performance.now();
        const before = process.threadCpuUsage();
        const allowed = db
          .prepare(
            `SELECT n.seq FROM node_vectors v JOIN nodes n ON n.seq=v.node_seq WHERE ${meaningfulNodeFilter} AND v.embedder=? AND n.project_id IN (?)`,
          )
          .all("fixture", "allowed")
          .map((row) => String(row.seq));
        const reply = yield* owner.execute({
          kind: "vector-search",
          epoch: owner.epoch,
          requestId: `old-${round}`,
          query: input.query!,
          k: 48,
          allowedIds: allowed,
        });
        if (
          reply.kind !== "vector-hits" ||
          reply.nativeWindow === undefined ||
          reply.workerCpuUs === undefined
        )
          return yield* new PairedFailed({ reason: "reply" });
        const mapped = reply.ids.map((seq) =>
          String(db.prepare("SELECT id FROM nodes WHERE seq=?").get(seq)!.id),
        );
        const channels = legacyFixtureChannels(db);
        const cpu = process.threadCpuUsage(before);
        samples.push({
          arm: "legacy-boundary",
          coldFirstCall: round === 0,
          wallMs: performance.now() - start,
          mainCpuMs: (cpu.user + cpu.system) / 1_000,
          workerBoundaryCpuMs: reply.workerCpuUs / 1_000,
          vectorWallMs:
            Number(BigInt(reply.nativeWindow.endNs) - BigInt(reply.nativeWindow.startNs)) / 1e6,
          sqlCalls: 1 + reply.ids.length + 6,
          candidateCount: allowed.length,
          inputLogicalBytes:
            64 +
            input.query!.byteLength +
            allowed.reduce((sum, value) => sum + Buffer.byteLength(value), 0),
          outputLogicalBytes: Buffer.byteLength(JSON.stringify({ mapped, channels })),
        });
        return { mapped, scores: reply.scores, channels };
      });
      const fresh = Effect.fnUntraced(function* (round: number) {
        const start = performance.now();
        const before = process.threadCpuUsage();
        const reply = yield* owner.execute({
          kind: "memory-search",
          epoch: owner.epoch,
          requestId: `new-${round}`,
          input,
        });
        if (
          reply.kind !== "memory-result" ||
          reply.result.kind !== "success" ||
          reply.workerCpuUs === undefined
        )
          return yield* new PairedFailed({ reason: "reply" });
        const result = reply.result;
        const cpu = process.threadCpuUsage(before);
        samples.push({
          arm: "native-read",
          coldFirstCall: round === 0,
          wallMs: performance.now() - start,
          mainCpuMs: (cpu.user + cpu.system) / 1_000,
          workerBoundaryCpuMs: reply.workerCpuUs / 1_000,
          vectorWallMs: result.vectorMs,
          sqlCalls: result.sqliteExecutions,
          candidateCount: result.candidateCount,
          inputLogicalBytes: result.inputLogicalBytes,
          outputLogicalBytes: result.outputLogicalBytes,
        });
        return {
          mapped: result.vectorIds,
          scores: result.vectorScores,
          channels: {
            text: result.textIds,
            morph: result.morphIds,
            unindexed: result.unindexed,
            uninterpreted: result.uninterpreted,
          },
        };
      });
      for (let round = 0; round < 13; round++) {
        // Alternate order after the first pair; first-call data is explicitly not OS/cache-cold.
        const pair =
          round % 2 === 0
            ? [yield* old(round), yield* fresh(round)]
            : [yield* fresh(round), yield* old(round)];
        if (JSON.stringify(pair[0]) !== JSON.stringify(pair[1]))
          return yield* new PairedFailed({ reason: "quality" });
      }
      console.log(
        JSON.stringify(
          {
            dimensions,
            bits: 4,
            candidateCount: extraCount + 2,
            vectorK: 48,
            rounds: 13,
            workerThreadId: owner.threadId,
            samples,
            note: "Same one worker/index and fixed temporary WAL data. Legacy arm moves candidate enumeration/strings and per-hit mapping through JS; native arm retains candidates and batches mapping. Boundary thread CPU includes N-API/SQLite, not pure engine CPU. Logical bytes differ in DTO accounting and are not serialized wire bytes. No concurrent API/RSS/default activation or full application p95 claim; first pair shares OS/index caches and is not true cold.",
          },
          null,
          2,
        ),
      );
    }).pipe(
      Effect.provide(
        NativeOwner.layer(
          {
            kind: "setup",
            epoch: "paired",
            dimensions,
            bits: 4,
            cacheDirectory: join(directory, "vector"),
            databasePath,
          },
          new URL("../packages/memory-agent/src/memory/native-search/worker.ts", import.meta.url),
        ),
      ),
    );
  }),
).pipe(Effect.timeout("60 seconds"));
await Effect.runPromise(observe);
