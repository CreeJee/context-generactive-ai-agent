import { Cause, Effect, Result } from "effect";
import { nativeFailure, nativePromise, runNativeEffect } from "../../runtime/native-effect.ts";
// The embedding model in a worker thread: onnxruntime-node runs a session synchronously, so on the
// main thread every batch would hold up the requests the server is answering meanwhile.
import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

if (!(parentPort !== null)) throw new Error("Embedding entry requires a worker parent port");
const parent = parentPort;

// The CommonJS build, resolved next to this file: in the package in a checkout, in the runtime
// folder in the executable.
const { AutoModel, AutoTokenizer, env }: typeof import("@huggingface/transformers") = createRequire(
  import.meta.url,
)("@huggingface/transformers");

// `devices` in order of preference: the first that loads and runs a short text is used.
const { cacheDir, modelId, modelFileName, maxTokens, devices } = workerData;

// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
const load = Effect.fn("EmbeddingWorker.load")(function* () {
  env.cacheDir = cacheDir;
  env.allowLocalModels = false;
  const tokenizer = yield* nativePromise(() => AutoTokenizer.from_pretrained(modelId));
  const failures: string[] = [];
  for (const device of devices) {
    let model: Awaited<ReturnType<typeof AutoModel.from_pretrained>> | null = null;
    const outcome = yield* Effect.result(
      Effect.gen(function* () {
        const loaded = yield* nativePromise(() =>
          AutoModel.from_pretrained(modelId, {
            dtype: "fp32",
            model_file_name: modelFileName,
            device,
            session_options: { enableCpuMemArena: false },
          }),
        );
        model = loaded;
        yield* nativePromise(() =>
          loaded(tokenizer(["준비"], { padding: true, truncation: true })),
        );
        return { tokenizer, model: loaded, device };
      }),
    );
    if (Result.isSuccess(outcome)) return outcome.success;
    failures.push(`${device}: ${String(nativeFailure(Cause.fail(outcome.failure)).cause)}`);
    if (model !== null) yield* nativePromise(() => model!.dispose()).pipe(Effect.ignore);
  }
  return yield* new Cause.UnknownError(new Error(failures.join("; ")));
});

const ready = runNativeEffect(load()).then(
  (loaded) => {
    // Unasked: tells the server which device the model runs on.
    parent.postMessage({ id: 0, kind: "loaded", device: loaded.device });
    return { kind: "ready" as const, loaded };
  },
  (error) => ({ kind: "failed" as const, error: String(error) }),
);

type LoadedModel = Effect.Success<ReturnType<typeof load>>;
const tokenCount = ({ tokenizer }: LoadedModel, text: string) =>
  tokenizer(text, { truncation: true, max_length: maxTokens }).input_ids.dims.at(-1) ?? 0;

/** The batch's sentence vectors, one row per text, not yet normalized. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
const embed = Effect.fn("EmbeddingWorker.embed")(function* (
  { tokenizer, model }: LoadedModel,
  texts: string[],
) {
  const inputs = tokenizer(texts, { padding: true, truncation: true, max_length: maxTokens });
  const { last_hidden_state: hidden } = yield* nativePromise<
    Awaited<ReturnType<LoadedModel["model"]>>
  >(() => model(inputs));
  const [batch, tokens, dimensions] = hidden.dims;
  // CLS pooling: the first token's hidden state is the sentence vector.
  const rows = new Float32Array(batch * dimensions);
  for (let row = 0; row < batch; row++) {
    const start = row * tokens * dimensions;
    rows.set(hidden.data.subarray(start, start + dimensions), row * dimensions);
  }
  return rows;
});

parent.on(
  "message",
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  ({ id, kind, texts }: { id: number; kind: "count" | "embed"; texts: string[] }) => {
    void runNativeEffect(
      Effect.gen(function* () {
        const state = yield* nativePromise(() => ready);
        if (state.kind === "failed")
          return parent.postMessage({ id, kind: "failed", stage: "load", reason: state.error });
        switch (kind) {
          case "count":
            return parent.postMessage({
              id,
              kind: "counts",
              counts: texts.map((text) => tokenCount(state.loaded, text)),
            });
          case "embed": {
            const rows = yield* embed(state.loaded, texts);
            return parent.postMessage({ id, kind: "rows", rows }, [rows.buffer]);
          }
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            parent.postMessage({
              id,
              kind: "failed",
              stage: "run",
              reason: String(nativeFailure(cause).cause),
            });
          }),
        ),
      ),
    );
  },
);
