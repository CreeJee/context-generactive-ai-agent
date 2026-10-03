// The embedding model in a worker thread: onnxruntime-node runs a session synchronously, so on the
// main thread every batch would hold up the requests the server is answering meanwhile.
import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

if (!parentPort) throw new Error("Embedding entry requires a worker parent port");
const parent = parentPort;

// The CommonJS build, resolved next to this file: in the package in a checkout, in the runtime
// folder in the executable.
const { AutoModel, AutoTokenizer, env }: typeof import("@huggingface/transformers") = createRequire(
  import.meta.url,
)("@huggingface/transformers");

// `devices` in order of preference: the first that loads and runs a short text is used.
const { cacheDir, modelId, modelFileName, maxTokens, devices } = workerData;

async function load() {
  env.cacheDir = cacheDir;
  env.allowLocalModels = false;
  const tokenizer = await AutoTokenizer.from_pretrained(modelId);
  const failures: string[] = [];
  for (const device of devices) {
    let model = null;
    try {
      model = await AutoModel.from_pretrained(modelId, {
        dtype: "fp32",
        model_file_name: modelFileName,
        device,
        // The arena keeps a batch's peak allocation for the next one; without it memory returns.
        session_options: { enableCpuMemArena: false },
      });
      // A device can load a session and still fail to run it.
      await model(tokenizer(["준비"], { padding: true, truncation: true }));
      return { tokenizer, model, device };
    } catch (error) {
      failures.push(`${device}: ${String(error)}`);
      await model?.dispose().catch(() => undefined);
    }
  }
  throw new Error(failures.join("; "));
}

const ready = load().then(
  (loaded) => {
    // Unasked: tells the server which device the model runs on.
    parent.postMessage({ id: 0, kind: "loaded", device: loaded.device });
    return { kind: "ready" as const, loaded };
  },
  (error) => ({ kind: "failed" as const, error: String(error) }),
);

type LoadedModel = Awaited<ReturnType<typeof load>>;
const tokenCount = ({ tokenizer }: LoadedModel, text: string) =>
  tokenizer(text, { truncation: true, max_length: maxTokens }).input_ids.dims.at(-1) ?? 0;

/** The batch's sentence vectors, one row per text, not yet normalized. */
async function embed({ tokenizer, model }: LoadedModel, texts: string[]) {
  const inputs = tokenizer(texts, { padding: true, truncation: true, max_length: maxTokens });
  const { last_hidden_state: hidden } = await model(inputs);
  const [batch, tokens, dimensions] = hidden.dims;
  // CLS pooling: the first token's hidden state is the sentence vector.
  const rows = new Float32Array(batch * dimensions);
  for (let row = 0; row < batch; row++) {
    const start = row * tokens * dimensions;
    rows.set(hidden.data.subarray(start, start + dimensions), row * dimensions);
  }
  return rows;
}

parent.on(
  "message",
  async ({ id, kind, texts }: { id: number; kind: "count" | "embed"; texts: string[] }) => {
    const state = await ready;
    if (state.kind === "failed")
      return parent.postMessage({ id, kind: "failed", stage: "load", reason: state.error });
    try {
      switch (kind) {
        case "count":
          return parent.postMessage({
            id,
            kind: "counts",
            counts: texts.map((text) => tokenCount(state.loaded, text)),
          });
        case "embed": {
          const rows = await embed(state.loaded, texts);
          return parent.postMessage({ id, kind: "rows", rows }, [rows.buffer]);
        }
      }
    } catch (error) {
      parent.postMessage({ id, kind: "failed", stage: "run", reason: String(error) });
    }
  },
);
