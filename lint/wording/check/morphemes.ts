import { createRequire } from "node:module";

import * as NodeServices from "@effect/platform-node/NodeServices";

import { Array as Arr, Context, Effect, Layer, Path, FileSystem, Schema } from "effect";
import { Digest } from "effect/crypto";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { KiwiBuilder } from "kiwi-nlp";
import type { TokenInfo } from "kiwi-nlp";

/** The model release that matches the `kiwi-nlp` version in the catalog; upgrade both together. */
const kiwiModel = {
  version: "0.24.1",
  url: "https://github.com/bab2min/Kiwi/releases/download/v0.24.1/kiwi_model_v0.24.1_base.tgz",
  sha256: "50d163e1af817444ef21f7ec5ea07ef69fb347282d57a6b49260f2039d4dc346",
  directory: "models/cong/base",
} as const;

/** The morpheme model could not be fetched, verified or loaded, so no sentence ending was checked. */
export class MorphemeModelUnavailable extends Schema.TaggedError<MorphemeModelUnavailable>()(
  "MorphemeModelUnavailable",
  { message: Schema.String },
) {}

/** Korean morpheme analysis (Kiwi), loaded once per process. */
export class Morphemes extends Context.Service<
  Morphemes,
  { readonly tokenize: (text: string) => ReadonlyArray<TokenInfo> }
>()("wording/Morphemes") {
  static readonly layer = Layer.effect(
    Morphemes,
    Effect.gen(function* () {
      const modelDirectory = yield* ensureModel;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const names = yield* fs.readDirectory(modelDirectory);
      const modelFiles = Object.fromEntries(
        yield* Effect.forEach(names, (name) =>
          Effect.map(
            fs.readFile(path.join(modelDirectory, name)),
            (bytes) => [name, bytes] as const,
          ),
        ),
      );
      const wasmPath = path.join(
        path.dirname(createRequire(import.meta.url).resolve("kiwi-nlp")),
        "kiwi-wasm.wasm",
      );
      const kiwi = yield* Effect.tryPromise({
        try: () =>
          KiwiBuilder.create(wasmPath).then((builder) =>
            builder.build({ modelFiles, modelType: "cong" }),
          ),
        catch: (cause) =>
          new MorphemeModelUnavailable({ message: `Kiwi를 불러오지 못했어요: ${String(cause)}` }),
      });
      return Morphemes.of({ tokenize: (text) => kiwi.tokenize(text) });
    }).pipe(
      Effect.catchTag("PlatformError", (error) =>
        Effect.fail(new MorphemeModelUnavailable({ message: error.message })),
      ),
    ),
  );
}

/** Kiwi on Node, with what it needs to fetch, verify and unpack its model on first use. */
export const morphemesLive = Morphemes.layer.pipe(
  Layer.provide([FetchHttpClient.layer, Digest.layerWebCrypto, NodeServices.layer]),
);

/**
 * The model directory, downloaded into `node_modules/.cache/wording` on first use. The archive
 * is checked against its digest and its entry names before anything is extracted, and it is
 * extracted next to the final place and then renamed, so an interrupted run never leaves half a
 * model in use.
 */
const ensureModel = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // From this file rather than the working directory: the lint rule may run from anywhere.
  const cacheRoot = path.resolve(import.meta.dirname, "../../../node_modules/.cache/wording");
  const root = path.join(cacheRoot, `kiwi-${kiwiModel.version}`);
  const modelDirectory = path.join(root, kiwiModel.directory);
  if (yield* fs.exists(path.join(modelDirectory, "cong.mdl"))) return modelDirectory;

  yield* Effect.logInfo(`Kiwi 모델 ${kiwiModel.version}을 받고 있어요 (약 88 MB, 처음 한 번만)`);
  const archive = yield* HttpClient.get(kiwiModel.url).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.arrayBuffer),
    Effect.map((buffer) => new Uint8Array(buffer)),
    Effect.mapError(
      (error) =>
        new MorphemeModelUnavailable({ message: `모델을 받지 못했어요: ${error.message}` }),
    ),
  );
  const digest = yield* Digest.Digest;
  const actual = yield* digest.digestHex(Digest.sha256, archive);
  if (actual !== kiwiModel.sha256) {
    return yield* new MorphemeModelUnavailable({ message: "모델 압축 파일의 sha256이 달라요" });
  }

  yield* fs.makeDirectory(cacheRoot, { recursive: true });
  const staging = yield* fs.makeTempDirectory({ directory: cacheRoot, prefix: ".kiwi-" });
  const extract = Effect.gen(function* () {
    const file = path.join(staging, "model.tgz");
    yield* fs.writeFile(file, archive);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const entries = yield* spawner.lines(ChildProcess.make("tar", ["-tzf", file]));
    if (Arr.some(entries, (entry) => entry.startsWith("/") || entry.split("/").includes(".."))) {
      return yield* new MorphemeModelUnavailable({
        message: "모델 압축 파일에 안전하지 않은 경로가 있어요",
      });
    }
    const exitCode = yield* spawner.exitCode(
      ChildProcess.make("tar", ["-xzf", file, "-C", staging]),
    );
    if (exitCode !== 0) {
      return yield* new MorphemeModelUnavailable({
        message: `모델 압축을 풀지 못했어요 (tar ${exitCode})`,
      });
    }
    yield* fs.remove(file);
    yield* fs.remove(root, { recursive: true, force: true });
    yield* fs.rename(staging, root);
  });
  yield* extract.pipe(Effect.onError(() => Effect.ignore(fs.remove(staging, { recursive: true }))));
  return modelDirectory;
});
