// Memory use of the in-process models, one scenario per process so peaks do not mix:
//   node --expose-gc --no-warnings eval/memory.ts            all scenarios
//   node --expose-gc --no-warnings eval/memory.ts <name>     one scenario
// Needs the models under ~/.context-generactive-agent/models. Reports macOS physical footprint
// (`footprint`), which is what memory pressure counts; compare scenarios run together.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { Effect, Layer, ManagedRuntime } from "effect";
import { KiwiBuilder } from "kiwi-nlp";
import { StorageRoot } from "../src/config/storage-root.ts";
import { Embedder, type ModelVariant } from "../src/memory/embedding/embedder.ts";
import { kiwiModel } from "../src/memory/morph/analyzer.ts";
import { runtimeRequire } from "../src/runtime/resources.ts";

const home = join(homedir(), ".context-generactive-agent");
/**
 * macOS physical footprint in MB, what the system counts against the process under memory
 * pressure. Unlike RSS it drops when freed memory is given back, even if pages stay mapped.
 */
const footprint = (field: "phys_footprint" | "phys_footprint_peak") => {
  const output = spawnSync("footprint", [String(process.pid)], { encoding: "utf8" }).stdout;
  const match = new RegExp(`${field}: ([0-9.]+) (KB|MB|GB)`).exec(output);
  if (!match) return null;
  const scale = { KB: 1 / 1024, MB: 1, GB: 1024 }[match[2] ?? "MB"] ?? 1;
  return Math.round(Number(match[1]) * scale);
};
const settle = async () => {
  for (let round = 0; round < 3; round++) {
    globalThis.gc?.();
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return footprint("phys_footprint");
};

const sentence = "배포는 화요일과 목요일 오후에만 하기로 했고 로그 포맷은 logfmt로 바꿨다. ";
/** About `tokens` tokens of Korean text. */
const textOfTokens = (tokens: number) => sentence.repeat(Math.ceil(tokens / 20));

async function kiwi(options: { loadMultiDict: boolean; loadTypoDict: boolean }) {
  const directory = join(home, "models", `kiwi-${kiwiModel.version}`, kiwiModel.directory);
  const wasm = join(dirname(runtimeRequire().resolve("kiwi-nlp")), "kiwi-wasm.wasm");
  const builder = await KiwiBuilder.create(wasm);
  const modelFiles = Object.fromEntries(
    readdirSync(directory).map((name) => [name, readFileSync(join(directory, name))]),
  );
  const instance = await builder.build({ modelFiles, modelType: "cong", ...options });
  instance.tokenize(sentence.repeat(50));
  return {};
}

/** Embeds through the app's Embedder, then disposes it and reports what memory came back. */
async function embed(variant: ModelVariant, texts: readonly string[]) {
  const runtime = ManagedRuntime.make(
    Embedder.localVariant(variant).pipe(Layer.provide(StorageRoot.layer(home))),
  );
  await runtime.runPromise(Effect.flatMap(Embedder, (embedder) => embedder.embed(texts)));
  const afterEmbedMB = await settle();
  await runtime.dispose();
  return { afterEmbedMB, afterReleaseMB: await settle() };
}

/** The same model in a worker thread that is ended afterwards: what an idle stop gives back. */
async function embedInWorker(file: string, texts: readonly string[]) {
  const worker = new Worker(new URL("./embed-worker-probe.mjs", import.meta.url), {
    workerData: { file, texts },
  });
  await new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
  const afterEmbedMB = await settle();
  await worker.terminate();
  return { afterEmbedMB, afterTerminateMB: await settle() };
}

/** Kiwi in a worker thread that is ended afterwards, as the analyzer's idle stop does. */
async function kiwiInWorker() {
  const directory = join(home, "models", `kiwi-${kiwiModel.version}`, kiwiModel.directory);
  const worker = new Worker(new URL("./kiwi-worker-probe.mjs", import.meta.url), {
    workerData: { directory },
  });
  await new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
  const afterLoadMB = await settle();
  await worker.terminate();
  return { afterLoadMB, afterTerminateMB: await settle() };
}

const mixed = [textOfTokens(8000), ...Array.from({ length: 15 }, () => textOfTokens(60))];
const short = Array.from({ length: 16 }, () => textOfTokens(60));

const scenarios = {
  "node baseline": async () => ({}),
  "kiwi cong (as used)": () => kiwi({ loadMultiDict: true, loadTypoDict: true }),
  "kiwi without multi/typo dict": () => kiwi({ loadMultiDict: false, loadTypoDict: false }),
  "embedder fp32, 16 short": () => embed("fp32", short),
  "embedder fp32, 1 long + 15 short": () => embed("fp32", mixed),
  "embedder quint8, 16 short": () => embed("quint8", short),
  "embedder quint8, 1 long + 15 short": () => embed("quint8", mixed),
  "kiwi worker, terminated": () => kiwiInWorker(),
  "kiwi worker, three restarts": async () => {
    const rounds = [];
    for (let round = 0; round < 3; round++) rounds.push(await kiwiInWorker());
    return { rounds };
  },
  "embedder quint8, three reloads": async () => {
    const rounds = [];
    for (let round = 0; round < 3; round++) rounds.push(await embed("quint8", short));
    return { rounds };
  },
  "worker fp32, 16 short": () => embedInWorker("model", short),
  "worker quint8, 16 short": () => embedInWorker("model_quint8_avx2", short),
} satisfies Record<string, () => Promise<object>>;

const only = process.argv[2];
if (only) {
  const scenario = Object.entries(scenarios).find(([name]) => name === only)?.[1];
  if (!scenario) throw new Error(`unknown scenario: ${only}`);
  const started = performance.now();
  const details = await scenario();
  console.log(
    JSON.stringify({
      scenario: only,
      peakMB: footprint("phys_footprint_peak"),
      ...details,
      ms: Math.round(performance.now() - started),
    }),
  );
} else {
  for (const name of Object.keys(scenarios)) {
    const result = spawnSync(
      process.execPath,
      [...process.execArgv, fileURLToPath(import.meta.url), name],
      { encoding: "utf8" },
    );
    const line = result.stdout.trim().split("\n").at(-1) ?? "";
    console.log(result.status === 0 ? line : `${name}: failed (${result.signal ?? result.status})`);
  }
}
