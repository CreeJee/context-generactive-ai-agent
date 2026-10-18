// Finite production-service fixture; never opens the application storage root.
import { NodeFileSystem, NodePath, NodeRuntime } from "@effect/platform-node";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { createServer } from "node:http";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { threadId, Worker } from "node:worker_threads";
import type { ProbeMessage } from "./native-search-api-probe.ts";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

// Count executions, not SQL contents. Proxies retain native receiver and all Node overloads.
const sqlCounts = { prepare: 0, all: 0, get: 0, run: 0, exec: 0 };
type SQLiteOperationResult =
  | ReturnType<StatementSync["all"]>
  | ReturnType<StatementSync["get"]>
  | ReturnType<StatementSync["run"]>;
const countedCall = <F extends (...args: SQLInputValue[]) => SQLiteOperationResult>(
  call: F,
  method: "all" | "get" | "run",
): F =>
  new Proxy(call, {
    apply(target, _receiver, parameters) {
      sqlCounts[method]++;
      return target(...parameters);
    },
  });
const openMeasuredDatabase = (file: string) => {
  const database = new DatabaseSync(file);
  const prepare = database.prepare.bind(database);
  database.prepare = (sql) => {
    sqlCounts.prepare++;
    const statement = prepare(sql);
    statement.all = countedCall(statement.all.bind(statement), "all");
    statement.get = countedCall(statement.get.bind(statement), "get");
    statement.run = countedCall(statement.run.bind(statement), "run");
    return statement;
  };
  const exec = database.exec.bind(database);
  database.exec = (sql) => {
    sqlCounts.exec++;
    return exec(sql);
  };
  return database;
};
const layerStartedAt = performance.now();
import { StorageRoot } from "../packages/memory-agent/src/config/storage-root.ts";
import { Database } from "../packages/memory-agent/src/db/database.ts";
import { Embedder } from "../packages/memory-agent/src/memory/embedding/embedder.ts";
import { VectorIndex } from "../packages/memory-agent/src/memory/embedding/vector-index.ts";
import { Graph } from "../packages/memory-agent/src/memory/graph.ts";
import { MorphAnalyzer } from "../packages/memory-agent/src/memory/morph/analyzer.ts";
import { MemorySearch } from "../packages/memory-agent/src/memory/search.ts";
import { fakeVector } from "../packages/memory-agent/src/testing/fake-embedder.ts";

class BaselineFailed extends Schema.TaggedError<BaselineFailed>()("BaselineFailed", {
  stage: Schema.String,
  cause: Schema.Defect(),
}) {}
const rows = 10_000;
const rounds = 20;
const text = "SQLite storage fixture decision";
const backend = "native" as const;
const benchmarkVector = (value: string) => {
  const vector = new Float32Array(384);
  vector.set(fakeVector(value));
  return vector;
};
const benchmarkEmbedder = Layer.succeed(Embedder, {
  identity: "fake-trigram-384",
  dimensions: 384,
  embed: (texts: readonly string[]) => Effect.succeed(texts.map(benchmarkVector)),
  runtime: () => ({ kind: "other" as const }),
});
const percentile = (values: readonly number[], fraction: number) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] ?? 0;
const summary = (values: readonly number[]) => ({
  medianMs: percentile(values, 0.5),
  p95Ms: percentile(values, 0.95),
  maxMs: percentile(values, 1),
});

// Manual host Promises are confined to measurement/listener instrumentation.
const benchmarkInstrumentation = {
  listen: () =>
    new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
      const server = createServer((_request, response) => response.end("ok"));
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(server));
    }),
  close: (server: ReturnType<typeof createServer>) =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
      server.closeAllConnections();
    }),
  turn: () => new Promise<void>((resolve) => setImmediate(resolve)),
  worker: () =>
    new Promise<Worker>((resolve, reject) => {
      const worker = new Worker(new URL("./native-search-api-probe.ts", import.meta.url));
      worker.once("message", () => resolve(worker));
      worker.once("error", reject);
    }),
  beginProbe: (worker: Worker, url: string) => {
    const started = Promise.withResolvers<void>();
    const done =
      Promise.withResolvers<Extract<ProbeMessage, { kind: "done" } | { kind: "failed" }>>();
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
    };
    const onError = () => {
      cleanup();
      started.resolve();
      done.resolve({ kind: "failed" });
    };
    const onMessage = (message: ProbeMessage) => {
      switch (message.kind) {
        case "ready":
          break;
        case "started":
          started.resolve();
          break;
        case "done":
        case "failed":
          cleanup();
          started.resolve();
          done.resolve(message);
          break;
      }
    };
    worker.on("message", onMessage);
    worker.once("error", onError);
    worker.postMessage(url);
    return { started: started.promise, done: done.promise };
  },
};
const morph = Layer.succeed(MorphAnalyzer, {
  identity: "baseline-fixed-terms",
  ready: () => true,
  warm: () => undefined,
  terms: (texts) => Effect.succeed(texts.map(() => ["sqlite", "storage"])),
});

const measurements = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const vectors = yield* VectorIndex;
  console.log(
    JSON.stringify({
      kind: "fresh-process-layer-startup",
      backend,
      scopedLayerStartupMs: performance.now() - layerStartedAt,
      processElapsedMs: process.uptime() * 1000,
      emptyFixtureStorage: true,
      osCacheCold: false,
      productionBackendStartup: backend === "native",
    }),
  );
  const stamp = "2026-01-01T00:00:00.000Z";
  yield* Effect.gen(function* () {
    for (const id of ["one", "two"]) {
      yield* sql`INSERT INTO projects(id, root, name, created_at) VALUES (${id}, ${`/fixture/${id}`}, ${id}, ${stamp})`;
      yield* sql`INSERT INTO sessions(id, project_id, created_at) VALUES (${id}, ${id}, ${stamp})`;
    }
    for (let seq = 1; seq <= rows; seq++) {
      const owner = seq % 2 === 0 ? "one" : "two";
      yield* sql`INSERT INTO nodes(seq,id,project_id,session_id,kind,text,created_at)
        VALUES (${seq}, ${`fixture-${seq}`}, ${owner}, ${owner}, 'user', ${`${text} ${seq % 100}`}, ${stamp})`;
      yield* sql`INSERT INTO nodes_morph(rowid,terms) VALUES (${seq}, 'sqlite storage')`;
      if (seq > 2)
        yield* sql`INSERT INTO edges(from_id,to_id,kind,origin,weight,created_at)
          VALUES (${`fixture-${seq}`}, ${`fixture-${seq - 2}`}, 'related', 'structure', 0.8, ${stamp})`;
    }
  }).pipe(
    sql.withTransaction,
    Effect.mapError((cause) => new BaselineFailed({ stage: "seed", cause })),
  );
  const seqs = Array.from({ length: rows }, (_, index) => index + 1);
  yield* vectors.add(
    seqs,
    seqs.map((seq) => benchmarkVector(`${text} ${seq % 100}`)),
  );
  yield* Effect.forEach(
    seqs,
    (seq) => sql`INSERT INTO node_vectors(node_seq,embedder) VALUES (${seq}, 'fake-trigram-384')`,
    { discard: true },
  ).pipe(
    sql.withTransaction,
    Effect.mapError((cause) => new BaselineFailed({ stage: "vector-records", cause })),
  );
  const search = yield* MemorySearch;
  const histogram = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const h = monitorEventLoopDelay({ resolution: 1 });
      h.enable();
      return h;
    }),
    (h) => Effect.sync(() => h.disable()),
  );
  const server = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: benchmarkInstrumentation.listen,
      catch: (cause) => new BaselineFailed({ stage: "control-listen", cause }),
    }),
    (listener) => Effect.promise(() => benchmarkInstrumentation.close(listener)),
  );
  const address = server.address();
  if (address === null || Schema.is(Schema.String)(address))
    return yield* new BaselineFailed({ stage: "control-address", cause: undefined });
  const probe = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: benchmarkInstrumentation.worker,
      catch: (cause) => new BaselineFailed({ stage: "probe-start", cause }),
    }),
    (worker) => Effect.promise(() => worker.terminate()),
  );
  const controlUrl = `http://127.0.0.1:${address.port}/control`;
  for (const crossProject of [false, true]) {
    const times: number[] = [];
    const stalls: number[] = [];
    const calls: number[] = [];
    const preparations: number[] = [];
    histogram.reset();
    for (let iteration = 0; iteration <= rounds; iteration++) {
      yield* Effect.promise(benchmarkInstrumentation.turn);
      const started = performance.now();
      const countsBefore = { ...sqlCounts };
      const result = yield* search.find({
        query: "SQLite storage",
        projectId: "one",
        crossProject,
        limit: 12,
      });
      const elapsedMs = performance.now() - started;
      const executions =
        sqlCounts.all +
        sqlCounts.get +
        sqlCounts.run +
        sqlCounts.exec -
        countsBefore.all -
        countsBefore.get -
        countsBefore.run -
        countsBefore.exec;
      if (iteration > 0) {
        calls.push(executions);
        preparations.push(sqlCounts.prepare - countsBefore.prepare);
      }
      const turnStarted = performance.now();
      yield* Effect.promise(benchmarkInstrumentation.turn);
      stalls.push(performance.now() - turnStarted);
      if (
        result.matches.length !== 12 ||
        result.degraded.length !== 0 ||
        result.unindexed !== 0 ||
        (!crossProject && result.matches.some((match) => match.projectId !== "one"))
      ) {
        return yield* new BaselineFailed({ stage: "result-contract", cause: undefined });
      }
      if (iteration === 0)
        console.log(
          JSON.stringify({
            kind: "first-call",
            backend,
            allowedProjects: crossProject ? 2 : 1,
            elapsedMs,
            processCold: false,
            threadId,
            rssBytes: process.memoryUsage().rss,
          }),
        );
      else times.push(elapsedMs);
    }
    console.log(
      JSON.stringify({
        kind: "warm",
        backend,
        allowedProjects: crossProject ? 2 : 1,
        rows,
        limit: 12,
        rounds,
        ...summary(times),
        postCallTurn: summary(stalls),
        eventLoopDelayP95Ms: histogram.percentile(95) / 1e6,
        eventLoopDelayMaxMs: histogram.max / 1e6,
        threadId,
        rssBytes: process.memoryUsage().rss,
        sqlExecutions: {
          median: percentile(calls, 0.5),
          p95: percentile(calls, 0.95),
          max: percentile(calls, 1),
        },
        sqlPreparations: {
          median: percentile(preparations, 0.5),
          p95: percentile(preparations, 0.95),
          max: percentile(preparations, 1),
        },
        sqlCounterOverheadIncluded: true,
      }),
    );
    // Warm the client's connections under idle conditions, then pin a 20-search burst.
    const idle = benchmarkInstrumentation.beginProbe(probe, controlUrl);
    yield* Effect.promise(() => idle.started);
    const idleResult = yield* Effect.promise(() => idle.done);
    const concurrent = benchmarkInstrumentation.beginProbe(probe, controlUrl);
    yield* Effect.promise(() => concurrent.started);
    const burstStarted = performance.now();
    for (let iteration = 0; iteration < rounds; iteration++) {
      yield* search.find({ query: "SQLite storage", projectId: "one", crossProject, limit: 12 });
    }
    const burstElapsedMs = performance.now() - burstStarted;
    const concurrentResult = yield* Effect.promise(() => concurrent.done);
    if (idleResult.kind === "failed" || concurrentResult.kind === "failed")
      return yield* new BaselineFailed({ stage: "concurrent-control", cause: undefined });
    if (concurrentResult.statuses.some((status) => status !== 200))
      return yield* new BaselineFailed({ stage: "concurrent-http-status", cause: undefined });
    console.log(
      JSON.stringify({
        kind: "concurrent-service-control",
        backend,
        allowedProjects: crossProject ? 2 : 1,
        burstSearches: rounds,
        burstElapsedMs,
        httpRequests: concurrentResult.statuses.length,
        httpConcurrency: 4,
        idleHttp: summary(idleResult.milliseconds),
        concurrentHttp: summary(concurrentResult.milliseconds),
        appEndpoint: false,
        threadId,
      }),
    );
  }
  const samples: number[] = [];
  for (let iteration = 0; iteration < rounds; iteration++) {
    const started = performance.now();
    yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch(`http://127.0.0.1:${address.port}/control`, {
          signal: AbortSignal.timeout(5000),
        });
        await response.text();
      },
      catch: (cause) => new BaselineFailed({ stage: "loopback-control", cause }),
    });
    samples.push(performance.now() - started);
  }
  console.log(
    JSON.stringify({
      kind: "loopback-http-control-only",
      concurrentWithSearch: false,
      appEndpoint: false,
      ...summary(samples),
    }),
  );
});

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "native-service-baseline-" });
  const base = Layer.mergeAll(
    Database.layer(`${temporary}/memory.sqlite`, openMeasuredDatabase),
    StorageRoot.layer(temporary),
    benchmarkEmbedder,
    morph,
  );
  const vectorLayer = VectorIndex.layer;
  const services = Layer.merge(Graph.layer, vectorLayer).pipe(Layer.provideMerge(base));
  const search = MemorySearch.layer.pipe(Layer.provideMerge(services));
  yield* measurements.pipe(Effect.provide(search));
}).pipe(
  Effect.scoped,
  Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
  Effect.timeout("90 seconds"),
);

NodeRuntime.runMain(
  program.pipe(
    Effect.catch(() =>
      Effect.sync(() => {
        console.log(JSON.stringify({ kind: "failed", details: "omitted-for-safe-output" }));
        process.exitCode = 1;
      }),
    ),
  ),
);
