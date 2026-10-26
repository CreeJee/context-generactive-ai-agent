import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeWorkerRunner from "@effect/platform-node/NodeWorkerRunner";
import { Cause, Effect, FileSystem, HashSet, Layer, Path, Result, Schema } from "effect";
import { RpcServer } from "effect/rpc";
import { nativeFailure, nativePromise, runNativeEffect } from "../../runtime/native-effect.ts";
import { KiwiRpcs, KiwiWorkerData, KiwiWorkerFailed } from "./kiwi-rpc.ts";
// Kiwi (Korean morphological analyzer) in a worker thread: the WASM model needs ~850 MB, so it
// lives here and the main thread can end the worker when it has been idle.
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { createRequire } from "node:module";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { workerData } from "node:worker_threads";
import { KiwiBuilder, type Kiwi } from "kiwi-nlp";

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

const failure = (stage: KiwiWorkerFailed["stage"]) => (cause: unknown) =>
  KiwiWorkerFailed.make({ stage, reason: String(nativeFailure(Cause.fail(cause)).cause) });

// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
const load = Effect.fn("KiwiWorker.load")(function* (modelDirectory: string) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  // Resolve beside this worker's own dependency so bundled callers retain the correct WASM path.
  const wasmPath = paths.join(
    paths.dirname(createRequire(import.meta.url).resolve("kiwi-nlp")),
    "kiwi-wasm.wasm",
  );
  const builder = yield* nativePromise(() => KiwiBuilder.create(wasmPath));
  const files = yield* Effect.forEach(
    yield* fs.readDirectory(modelDirectory),
    Effect.fnUntraced(function* (name) {
      const path = paths.join(modelDirectory, name);
      // readdir's previous isFile contract excluded symbolic links, including dangling links.
      const link = yield* fs.readLink(path).pipe(Effect.result);
      const regular = Result.isFailure(link) && (yield* fs.stat(path)).type === "File";
      return regular ? [[name, yield* fs.readFile(path)] as const] : [];
    }),
  );
  const modelFiles = Object.fromEntries(files.flat());
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

const handlers = KiwiRpcs.toLayer(
  Effect.gen(function* () {
    const setup = yield* Schema.decodeUnknownEffect(KiwiWorkerData)(workerData).pipe(
      Effect.mapError(failure("load")),
    );
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    // Built once per worker; a failed build stays failed, and the host starts a new worker.
    const kiwi = yield* Effect.cached(
      load(setup.modelDirectory).pipe(
        Effect.provideContext(services),
        Effect.mapError(failure("load")),
      ),
    );
    return KiwiRpcs.of({
      Load: () => Effect.asVoid(kiwi),
      Terms: ({ texts }) =>
        Effect.flatMap(kiwi, (loaded) =>
          Effect.try({
            try: () => texts.map((text) => termsOf(loaded, text)),
            catch: failure("run"),
          }),
        ),
    });
  }),
).pipe(Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)));

const protocol = RpcServer.layerProtocolWorkerRunner.pipe(Layer.provide(NodeWorkerRunner.layer));
// One request at a time: tokenizing is synchronous, and the host bounds requests the same way.
const server = RpcServer.layer(KiwiRpcs, { concurrency: 1 }).pipe(
  Layer.provide(handlers),
  Layer.provide(protocol),
);

await runNativeEffect(Layer.launch(server));
