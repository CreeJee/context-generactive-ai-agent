// Probe for eval/memory.ts: loads the embedding model in a worker thread and embeds once.
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";

const require = createRequire(import.meta.url);
const { AutoModel, AutoTokenizer, env } = require("@huggingface/transformers");
env.cacheDir = join(homedir(), ".context-generactive-agent", "models");
env.allowRemoteModels = false;
const id = "ibm-granite/granite-embedding-97m-multilingual-r2";
const [tokenizer, model] = await Promise.all([
  AutoTokenizer.from_pretrained(id),
  AutoModel.from_pretrained(id, {
    dtype: "fp32",
    model_file_name: workerData.file,
    session_options: { enableCpuMemArena: false },
  }),
]);
await model(tokenizer(workerData.texts, { padding: true, truncation: true, max_length: 2048 }));
parentPort.postMessage("done");
