import { nativeFailure, nativePromise, runNativeEffect } from "../../runtime/native-effect.ts";
import { Effect, FileSystem, HashSet, Layer, Path } from "effect";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
// Kiwi (Korean morphological analyzer) in a worker thread: the WASM model needs ~850 MB, so it
// lives here and the main thread can end the worker when it has been idle.
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { createRequire } from "node:module";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { parentPort, workerData } from "node:worker_threads";
import { KiwiBuilder, type Kiwi } from "kiwi-nlp";

if (!(parentPort !== null)) throw new Error("Kiwi entry requires a worker parent port");
const parent = parentPort;

/** Parts of speech worth searching by: nouns, numerals, verb/adjective stems, roots, Hanja. */
const kept = HashSet.fromIterable(["NNG", "NNP", "NR", "VV", "VA", "XR", "SH"]);
const nouns = HashSet.fromIterable(["NNG", "NNP"]);
/** Stems that occur in almost every sentence ("하기로 했다", "있다") and only add noise. */
const lightStems = HashSet.fromIterable([
  "하",
  "되",
  "있",
  "없",
  "않",
  "같",
  "이",
  "아니",
  "어떻",
  "어떠",
  "그렇",
  "이렇",
  "저렇",
]);
/**
 * Latin words and numbers are taken from the text itself: Kiwi sometimes splits them oddly
 * ("Grafana" → "Gr" + "afana"), and a plain split keeps "drizzle-kit" findable by either half.
 */
const latinOrNumber = /[\p{Script=Latin}\p{Nd}]+/gu;

// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
const load = Effect.fn("KiwiWorker.load")(function* () {
  const services = yield* Layer.build(Layer.merge(NodeFileSystem.layer, NodePath.layer));
  const fs = yield* Effect.provideContext(FileSystem.FileSystem, services);
  const paths = yield* Effect.provideContext(Path.Path, services);
  // Resolve beside this worker's own dependency so bundled callers retain the correct WASM path.
  const wasmPath = paths.join(
    paths.dirname(createRequire(import.meta.url).resolve("kiwi-nlp")),
    "kiwi-wasm.wasm",
  );
  const builder = yield* nativePromise(() => KiwiBuilder.create(wasmPath));
  const modelFiles: Record<string, Uint8Array> = {};
  for (const name of yield* fs.readDirectory(workerData.modelDirectory)) {
    const path = paths.join(workerData.modelDirectory, name);
    // readdir's previous isFile contract excluded symbolic links, including dangling links.
    const link = yield* fs.readLink(path).pipe(Effect.result);
    if (link._tag === "Success") continue;
    const info = yield* fs.stat(path);
    if (info.type === "File") modelFiles[name] = yield* fs.readFile(path);
  }
  return yield* nativePromise(() => builder.build({ modelFiles, modelType: "cong" }));
});

function termsOf(kiwi: Kiwi, input: string) {
  const text = input.normalize("NFKC");
  const terms: string[] = [];
  // Compound nouns are split inconsistently ("데이터베이스" vs "데이터 베이스"), so a run of nouns
  // written without spaces also counts as one term.
  let run: string[] = [];
  let runEnd = -1;
  const closeRun = () => {
    if (run.length > 1) terms.push(run.join(""));
    run = [];
  };
  for (const token of kiwi.tokenize(text)) {
    const tag = token.tag.replace(/-[RI]$/, "");
    if (HashSet.has(nouns, tag)) {
      if (token.position !== runEnd) closeRun();
      run.push(token.str);
      runEnd = token.position + token.length;
    } else closeRun();
    const latin = token.str.search(latinOrNumber) >= 0;
    if (HashSet.has(kept, tag) && !HashSet.has(lightStems, token.str) && !latin)
      terms.push(token.str);
  }
  closeRun();
  for (const [word] of text.matchAll(latinOrNumber)) terms.push(word);
  return terms.map((term) => term.toLowerCase());
}

const ready = runNativeEffect(Effect.scoped(load())).then(
  (kiwi) => ({ kind: "ready" as const, kiwi }),
  (error) => ({ kind: "failed" as const, error: String(error) }),
);

// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
parent.on("message", ({ id, texts }: { id: number; texts: string[] }) => {
  void runNativeEffect(
    Effect.gen(function* () {
      const state = yield* nativePromise(() => ready);
      if (state.kind === "failed")
        return parent.postMessage({ id, kind: "error", error: state.error });
      const terms = texts.map((text) => termsOf(state.kiwi, text));
      parent.postMessage({ id, kind: "terms", terms });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          parent.postMessage({ id, kind: "error", error: String(nativeFailure(cause).cause) });
        }),
      ),
    ),
  );
});
