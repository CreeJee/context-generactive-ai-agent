// Probe for eval/memory.ts: builds Kiwi in a worker thread and analyzes once.
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { KiwiBuilder } from "kiwi-nlp";

const wasm = join(dirname(createRequire(import.meta.url).resolve("kiwi-nlp")), "kiwi-wasm.wasm");
const builder = await KiwiBuilder.create(wasm);
const modelFiles = Object.fromEntries(
  readdirSync(workerData.directory).map((name) => [
    name,
    readFileSync(join(workerData.directory, name)),
  ]),
);
const kiwi = await builder.build({ modelFiles, modelType: "cong" });
kiwi.tokenize("배포는 화요일과 목요일 오후에만 하기로 했다.");
parentPort.postMessage("done");
