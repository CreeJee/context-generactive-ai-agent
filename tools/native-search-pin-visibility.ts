// Finite cross-isolate pin observation fixture; not an application waiter or performance benchmark.
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { Schema } from "effect";
import { addonPath, loadTurbovec } from "../packages/turbovec/index.js";
import { initializeNodeSqlite } from "../packages/memory-agent/src/runtime/node-sqlite-bridge.ts";
import { createReadFixture } from "../packages/memory-agent/src/memory/native-search/read-fixture.ts";
class PinObservationFailed extends Schema.TaggedError<PinObservationFailed>()(
  "PinObservationFailed",
  { reason: Schema.Literals(["timeout", "reply", "not-inflight", "worker"]) },
) {}
const Setup = Schema.Struct({ databasePath: Schema.String });
const Run = Schema.Struct({
  token: Schema.String,
  ownerKey: Schema.String,
  epoch: Schema.String,
  requestId: Schema.String,
});
const Done = Schema.Struct({
  kind: Schema.Literal("done"),
  result: Schema.String,
  startNs: Schema.String,
  endNs: Schema.String,
});
if (!isMainThread) {
  const setup = Schema.decodeUnknownSync(Setup)(workerData);
  const native = loadTurbovec();
  initializeNodeSqlite(addonPath);
  const reader = new native.MemoryReadSession(setup.databasePath);
  const index = new native.VectorIndex(384, 4);
  if (parentPort === null) throw new PinObservationFailed({ reason: "worker" });
  const port = parentPort;
  port.on("message", (message) => {
    const run = Schema.decodeUnknownSync(Run)(message);
    const startNs = process.hrtime.bigint();
    const result = reader.search(
      index,
      {
        allowedProjects: ["allowed"],
        embedder: "fixture",
        trigramTerms: ["sqlite"],
        shortTerms: [],
        morphTerms: [],
        vectorK: 1,
        textK: 2,
        morphK: 1,
        textEnabled: true,
        morphEnabled: false,
        remainingMs: 2_000,
        inputBudgetBytes: 65_536,
        outputBudgetBytes: 4_096,
      },
      run.token,
      run.ownerKey,
      run.epoch,
      run.requestId,
    );
    const endNs = process.hrtime.bigint();
    port.postMessage({
      kind: "done",
      result: result.kind,
      startNs: String(startNs),
      endNs: String(endNs),
    });
  });
  port.postMessage({ kind: "ready" });
} else {
  const directory = mkdtempSync(join(tmpdir(), "pin-observe-"));
  const databasePath = join(directory, "fixture.sqlite");
  const db = createReadFixture(databasePath);
  try {
    const insert = db.prepare("INSERT INTO nodes VALUES(?,?,'user','allowed','sqlite fixture')");
    const text = db.prepare("INSERT INTO nodes_fts(rowid,text) VALUES(?,'sqlite fixture')");
    db.exec("BEGIN");
    for (let row = 100; row < 50_100; row++) {
      insert.run(row, `fixture-${row}`);
      text.run(row);
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  const worker = new Worker(new URL(import.meta.url), { workerData: { databasePath } });
  const native = loadTurbovec();
  let control: InstanceType<typeof native.SearchControl> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("message", (message) => {
        if (Schema.is(Schema.Struct({ kind: Schema.Literal("ready") }))(message)) resolve();
        else reject(new PinObservationFailed({ reason: "reply" }));
      });
    });
    const ownerKey = randomUUID();
    const epoch = "pin-observe";
    const requestId = "one";
    control = new native.SearchControl(randomUUID(), ownerKey, epoch, requestId, 2_000);
    const reply = new Promise<Schema.Schema.Type<typeof Done>>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("message", (message) => {
        try {
          resolve(Schema.decodeUnknownSync(Done)(message));
        } catch {
          reject(new PinObservationFailed({ reason: "reply" }));
        }
      });
    });
    worker.postMessage({ token: control.token(), ownerKey, epoch, requestId });
    const stop = process.hrtime.bigint() + 2_000_000_000n;
    // Deliberate finite fixture spin only. Production Effect waiter must not spin.
    while (!control.snapshotWasPinned()) {
      if (process.hrtime.bigint() >= stop) throw new PinObservationFailed({ reason: "timeout" });
    }
    const observedNs = process.hrtime.bigint();
    const done = await reply;
    const observedInsideNative =
      observedNs >= BigInt(done.startNs) && observedNs < BigInt(done.endNs);
    if (done.result !== "success" || !observedInsideNative)
      throw new PinObservationFailed({ reason: "not-inflight" });
    console.log(
      JSON.stringify({
        candidateFixtureRows: 50_000,
        observedInsideNative,
        result: done.result,
        note: "Request-local actual pin observed from main isolate while synchronous worker N-API call was still running. Does not prove public generation consistency or provide a production polling implementation.",
      }),
    );
  } finally {
    control?.close();
    await worker.terminate();
    rmSync(directory, { recursive: true, force: true });
  }
}
