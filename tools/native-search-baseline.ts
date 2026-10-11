// Finite, synthetic boundary benchmark. No application DB, embedding service or cache files.
// Node timers/Promises below are instrumentation, not a memory-agent execution implementation.
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { isMainThread, parentPort, threadId, Worker, workerData } from "node:worker_threads";
import { loadTurbovec } from "../packages/turbovec/index.js";

const dimensions = 384;
const rounds = 20;
const k = 48;
const percentile = (values: readonly number[], fraction: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
};
const summary = (values: readonly number[]) => ({
  median: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  max: percentile(values, 1),
});

interface ProbeResult {
  readonly kind: "done";
  readonly milliseconds: readonly number[];
  readonly statuses: readonly number[];
}
interface ProbeStart {
  readonly kind: "started";
}
interface ProbeReady {
  readonly kind: "ready";
}
type ProbeMessage = ProbeResult | ProbeStart | ProbeReady;

if (!isMainThread && workerData === "http-probe") {
  parentPort!.on("message", async (url: string) => {
    parentPort!.postMessage({ kind: "started" } satisfies ProbeStart);
    const samples = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const times: number[] = [];
        const statuses: number[] = [];
        for (let iteration = 0; iteration < 5; iteration++) {
          const started = performance.now();
          const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
          await response.text();
          times.push(performance.now() - started);
          statuses.push(response.status);
        }
        return { times, statuses };
      }),
    );
    parentPort!.postMessage({
      kind: "done",
      milliseconds: samples.flatMap((sample) => sample.times),
      statuses: samples.flatMap((sample) => sample.statuses),
    } satisfies ProbeResult);
  });
  parentPort!.postMessage({ kind: "ready" } satisfies ProbeReady);
} else if (isMainThread) {
  const server = createServer((_request, response) => response.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || !(address instanceof Object)) throw new Error("No benchmark listener");
  const url = `http://127.0.0.1:${address.port}/control`;
  const probe = new Worker(new URL(import.meta.url), { workerData: "http-probe" });
  await new Promise<void>((resolve, reject) => {
    probe.once("message", () => resolve());
    probe.once("error", reject);
  });
  const runProbe = (work: () => void) =>
    new Promise<ProbeResult>((resolve, reject) => {
      const onMessage = (message: ProbeMessage) => {
        switch (message.kind) {
          case "ready":
            break;
          case "started":
            try {
              work();
            } catch (error) {
              cleanup();
              reject(error);
            }
            break;
          case "done":
            cleanup();
            resolve(message);
            break;
        }
      };
      const cleanup = () => {
        probe.off("message", onMessage);
        probe.off("error", onError);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      probe.on("message", onMessage);
      probe.once("error", onError);
      probe.postMessage(url);
    });
  try {
    // Warm the independent HTTP client's connection before collecting its idle control.
    await runProbe(() => {});
    const idle = await runProbe(() => {});
    const output: unknown[] = [];
    const { VectorIndex } = loadTurbovec();
    for (const count of [10_000, 50_000]) {
      const sqlite = new DatabaseSync(":memory:");
      try {
        sqlite.exec(`
          CREATE TABLE nodes(seq INTEGER PRIMARY KEY, id TEXT, project_id TEXT, text TEXT);
          CREATE TABLE node_vectors(node_seq INTEGER PRIMARY KEY, embedder TEXT);
          CREATE VIRTUAL TABLE nodes_fts USING fts5(text, tokenize='trigram');
          CREATE VIRTUAL TABLE nodes_morph USING fts5(text);
          BEGIN;
        `);
        const node = sqlite.prepare("INSERT INTO nodes VALUES (?, ?, ?, ?)");
        const vector = sqlite.prepare("INSERT INTO node_vectors VALUES (?, 'fixture')");
        const text = sqlite.prepare("INSERT INTO nodes_fts(rowid, text) VALUES (?, ?)");
        const morph = sqlite.prepare("INSERT INTO nodes_morph(rowid, text) VALUES (?, ?)");
        const matrix = new Float32Array(count * dimensions);
        const ids: string[] = [];
        for (let seq = 1; seq <= count; seq++) {
          node.run(seq, `node-${seq}`, `project-${seq % 4}`, `memory search latency ${seq}`);
          vector.run(seq);
          text.run(seq, `memory search latency ${seq}`);
          morph.run(seq, "memory search latency");
          ids.push(String(seq));
          let norm = 0;
          for (let column = 0; column < dimensions; column++) {
            const value = Math.sin(seq * 0.17 + column * 0.31);
            matrix[(seq - 1) * dimensions + column] = value;
            norm += value * value;
          }
          for (let column = 0; column < dimensions; column++)
            matrix[(seq - 1) * dimensions + column]! /= Math.sqrt(norm);
        }
        sqlite.exec("COMMIT");
        const index = new VectorIndex(dimensions, 4);
        index.add(matrix, ids);
        const query = matrix.slice(0, dimensions);
        for (const projects of [
          ["project-0"],
          ["project-0", "project-1", "project-2", "project-3"],
        ]) {
          const parameters = projects.map(() => "?").join(",");
          const candidates =
            sqlite.prepare(`SELECT n.seq FROM node_vectors v JOIN nodes n ON n.seq = v.node_seq
            WHERE v.embedder = ? AND n.project_id IN (${parameters})`);
          const bySeq = sqlite.prepare("SELECT id FROM nodes WHERE seq = ?");
          const fts = sqlite.prepare(`SELECT n.id FROM nodes_fts f JOIN nodes n ON n.seq = f.rowid
            WHERE nodes_fts MATCH ? AND n.project_id IN (${parameters}) ORDER BY f.rank LIMIT ?`);
          const morphology =
            sqlite.prepare(`SELECT n.id FROM nodes_morph f JOIN nodes n ON n.seq = f.rowid
            WHERE nodes_morph MATCH ? AND n.project_id IN (${parameters}) ORDER BY f.rank LIMIT ?`);
          const timings: Record<
            | "candidates"
            | "conversion"
            | "native"
            | "mapping"
            | "fts"
            | "morph"
            | "total"
            | "nativeBoundaryThreadCpu",
            number[]
          > = {
            candidates: [],
            conversion: [],
            native: [],
            mapping: [],
            fts: [],
            morph: [],
            total: [],
            nativeBoundaryThreadCpu: [],
          };
          let candidateCount = 0;
          let candidateIdUtf8Bytes = 0;
          let responseJsonBytes = 0;
          let sqlCalls = 0;
          let candidateHeapDelta = 0;
          const sample = () => {
            const started = performance.now();
            const heapBefore = process.memoryUsage().heapUsed;
            const seqs = candidates.all("fixture", ...projects).map((row) => Number(row.seq));
            const selected = performance.now();
            const allowed = seqs.map(String);
            const converted = performance.now();
            candidateHeapDelta = Math.max(
              candidateHeapDelta,
              process.memoryUsage().heapUsed - heapBefore,
            );
            const nativeCpuBefore = process.threadCpuUsage();
            const hits = index.search(query, k, allowed);
            const searched = performance.now();
            const nativeCpu = process.threadCpuUsage(nativeCpuBefore);
            timings.nativeBoundaryThreadCpu.push((nativeCpu.user + nativeCpu.system) / 1000);
            const mapped = hits.ids.map((id) => bySeq.get(Number(id))!.id);
            const mappedAt = performance.now();
            const byText = fts.all('"memory"', ...projects, k / 2);
            const textAt = performance.now();
            const byMorph = morphology.all('"memory"', ...projects, k / 2);
            const ended = performance.now();
            timings.candidates.push(selected - started);
            timings.conversion.push(converted - selected);
            timings.native.push(searched - converted);
            timings.mapping.push(mappedAt - searched);
            timings.fts.push(textAt - mappedAt);
            timings.morph.push(ended - textAt);
            timings.total.push(ended - started);
            // Payload accounting is done only on the first (untimed-control) observation.
            if (candidateCount === 0) {
              candidateCount = allowed.length;
              candidateIdUtf8Bytes = allowed.reduce((sum, id) => sum + Buffer.byteLength(id), 0);
              responseJsonBytes = Buffer.byteLength(JSON.stringify({ mapped, byText, byMorph }));
              sqlCalls = 3 + hits.ids.length;
            }
          };
          sample();
          const first = Object.fromEntries(
            Object.entries(timings).map(([stage, values]) => [stage, values[0]]),
          );
          Object.values(timings).forEach((values) => values.splice(0));
          const lag = monitorEventLoopDelay({ resolution: 10 });
          lag.enable();
          await new Promise((resolve) => setTimeout(resolve, 25));
          const before = process.memoryUsage();
          const cpuBefore = process.cpuUsage();
          const api = await runProbe(() => {
            for (let iteration = 0; iteration < rounds; iteration++) sample();
          });
          await new Promise((resolve) => setTimeout(resolve, 25));
          const cpu = process.cpuUsage(cpuBefore);
          const after = process.memoryUsage();
          lag.disable();
          if (api.statuses.some((status) => status !== 200)) throw new Error("HTTP control failed");
          output.push({
            count,
            projects: projects.length,
            dimensions,
            bits: 4,
            k,
            rounds,
            isMainThread,
            threadId,
            candidateCount,
            candidateIdUtf8Bytes,
            queryFloat32Bytes: query.byteLength,
            responseJsonBytes,
            sqlCallsPerSearch: sqlCalls,
            firstObservationMs: first,
            warmStageMs: Object.fromEntries(
              Object.entries(timings).map(([stage, values]) => [stage, summary(values)]),
            ),
            httpControlMs: summary(api.milliseconds),
            httpRequests: api.statuses.length,
            eventLoopMs: { p95: lag.percentile(95) / 1e6, max: lag.max / 1e6 },
            processCpuMs: { user: cpu.user / 1000, system: cpu.system / 1000 },
            memoryBytes: { before, after, candidateHeapDeltaUpperObserved: candidateHeapDelta },
          });
        }
      } finally {
        sqlite.close();
      }
    }
    console.log(
      JSON.stringify(
        {
          version: 1,
          node: process.version,
          idleHttpMs: summary(idle.milliseconds),
          note: "Synthetic in-memory boundary fixture; first observation is not process-cold. UTF8 ID bytes exclude V8/NAPI overhead. Native wall includes NAPI input/output conversion; process CPU is not native-only CPU. HTTP is a loopback control, not application API. No graph/embedding/analyzer/provenance work measured.",
          cases: output,
        },
        null,
        2,
      ),
    );
  } finally {
    await probe.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
