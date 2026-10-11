// Finite direct-ABI stress, not application orchestration. The main Atomics wait/GC
// are measurement-only gates; do not reuse them in the server or Effect transport.
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { loadTurbovec, type ControlledSearchResult } from "../packages/turbovec/index.js";

interface RunRequest {
  readonly kind: "run";
  readonly id: number;
  readonly token: string;
  readonly gate: SharedArrayBuffer;
}
type Reply =
  | { readonly kind: "ready" }
  | {
      readonly kind: "result";
      readonly id: number;
      readonly startNs: string;
      readonly endNs: string;
      readonly result: ControlledSearchResult;
    };

if (!isMainThread && workerData === "native-control-visibility") {
  const dimensions = 384;
  const count = 50_000;
  const { VectorIndex } = loadTurbovec();
  const index = new VectorIndex(dimensions, 4);
  const matrix = new Float32Array(count * dimensions);
  const ids = Array.from({ length: count }, (_, row) => String(row + 1));
  for (let row = 0; row < count; row++) {
    let norm = 0;
    for (let column = 0; column < dimensions; column++) {
      const value = Math.sin(row * 0.17 + column * 0.31);
      matrix[row * dimensions + column] = value;
      norm += value * value;
    }
    for (let column = 0; column < dimensions; column++)
      matrix[row * dimensions + column]! /= Math.sqrt(norm);
  }
  index.add(matrix, ids);
  const query = matrix.slice(0, dimensions);
  index.search(query, 48, ids); // Warm layout separately; not a cold/preemption guarantee.
  parentPort!.on("message", (request: RunRequest) => {
    const gate = new Int32Array(request.gate);
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    const startNs = process.hrtime.bigint();
    // Registry claim binds the main-thread-created native state; no JS backing-store pointer.
    const result = index.searchControlled(
      query,
      48,
      request.token,
      "visibility-owner",
      "visibility-epoch",
      String(request.id),
      ids,
    );
    const endNs = process.hrtime.bigint();
    parentPort!.postMessage({
      kind: "result",
      id: request.id,
      startNs: String(startNs),
      endNs: String(endNs),
      result,
    } satisfies Reply);
  });
  parentPort!.postMessage({ kind: "ready" } satisfies Reply);
} else if (isMainThread) {
  if (global.gc === undefined) throw new Error("Run this finite ABI observation with --expose-gc");
  const worker = new Worker(new URL(import.meta.url), {
    workerData: "native-control-visibility",
    execArgv: [],
  });
  const awaitReply = () =>
    new Promise<Reply>((resolve, reject) => {
      const cleanup = () => {
        worker.off("message", onMessage);
        worker.off("error", onError);
      };
      const onMessage = (reply: Reply) => {
        cleanup();
        resolve(reply);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      worker.once("message", onMessage);
      worker.once("error", onError);
    });
  const observations: {
    writtenInsideNativeCall: boolean;
    kind: string;
    nativeMs: number;
    gcPerformed: boolean;
    observationOffsetMs: number;
    wholeNapiCallMs: number;
  }[] = [];
  try {
    const ready = await awaitReply();
    if (ready.kind !== "ready") throw new Error("Unexpected ABI readiness reply");
    for (let id = 0; id < 20; id++) {
      const token = randomUUID();
      const control = new (loadTurbovec().SearchControl)(
        token,
        "visibility-owner",
        "visibility-epoch",
        String(id),
        2_000,
      );
      const gate = new SharedArrayBuffer(8);
      const reply = awaitReply();
      worker.postMessage({ kind: "run", id, token: control.token(), gate } satisfies RunRequest);
      if (Atomics.wait(new Int32Array(gate), 0, 0, 5_000) === "timed-out")
        throw new Error("ABI observation gate timed out");
      // Deliberate measurement offset. Classification uses timestamps, not the delay.
      const observationOffsetMs = [2, 5, 8, 12, 20][id % 5]!;
      Atomics.wait(new Int32Array(gate), 1, 0, observationOffsetMs);
      const writtenNs = process.hrtime.bigint();
      control.cancel();
      global.gc();
      const completed = await reply;
      control.close();
      if (completed.kind !== "result" || completed.id !== id)
        throw new Error("Mismatched ABI observation reply");
      const inside = writtenNs > BigInt(completed.startNs) && writtenNs < BigInt(completed.endNs);
      if (inside && completed.result.kind !== "cancelled")
        throw new Error("In-flight shared cancellation was not observed");
      observations.push({
        writtenInsideNativeCall: inside,
        kind: completed.result.kind,
        nativeMs: completed.result.nativeMs,
        gcPerformed: true,
        observationOffsetMs,
        wholeNapiCallMs: Number(BigInt(completed.endNs) - BigInt(completed.startNs)) / 1e6,
      });
    }
    const inside = observations.filter((sample) => sample.writtenInsideNativeCall).length;
    if (inside === 0) throw new Error("No actual in-flight sample; measurement is inconclusive");
    console.log(
      JSON.stringify(
        {
          rounds: observations.length,
          inFlightWrites: inside,
          mainGcRuns: observations.length,
          observations,
          note: "Main-thread Rust-owned AtomicBool cancellation timestamped inside synchronous N-API call windows with main-isolate GC. SAB only provides a measurement gate, never native control memory. Not a scoring midpoint hook, worker-isolate forced GC, hard deadline or mid-scan preemption proof. No persistent cache/writer/application DB used.",
        },
        null,
        2,
      ),
    );
  } finally {
    await worker.terminate();
  }
}
