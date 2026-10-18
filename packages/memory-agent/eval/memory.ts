import { nativePromise, runNativeEffect } from "../src/runtime/native-effect.ts";
import { isTruthy } from "../src/truthy.ts";
// Memory use of the in-process models, one scenario per process so peaks do not mix:
//   node --expose-gc --no-warnings eval/memory.ts            all scenarios
//   node --expose-gc --no-warnings eval/memory.ts <name>     one scenario
// Needs the models under ~/.context-generactive-agent/models. Reports macOS physical footprint
// (`footprint`), which is what memory pressure counts; compare scenarios run together.
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { runProcess } from "../src/rrsi/command.ts";
import { runOAuthNodeEffect } from "../src/oauth/node-runtime.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { Duration, FileSystem } from "effect";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { path } from "../src/runtime/synchronous-path.ts";
const { dirname, join } = path;
import { Console, Effect, Layer } from "effect";
import { KiwiBuilder } from "kiwi-nlp";
import { StorageRoot, defaultStorageRoot } from "../src/config/storage-root.ts";
import { Embedder, type ModelVariant } from "../src/memory/embedding/embedder.ts";
import { kiwiModel } from "../src/memory/morph/analyzer.ts";
import { runtimeRequire } from "../src/runtime/resources.ts";

const home = defaultStorageRoot;
/**
 * macOS physical footprint in MB, what the system counts against the process under memory
 * pressure. Unlike RSS it drops when freed memory is given back, even if pages stay mapped.
 */
const footprint = Effect.fn("eval.footprint")(function* (
  field: "phys_footprint" | "phys_footprint_peak",
) {
  const { stdout: output } = yield* nativePromise(() =>
    runProcess({ command: "footprint", args: [String(process.pid)] }),
  );
  const match = new RegExp(`${field}: ([0-9.]+) (KB|MB|GB)`).exec(output);
  if (!isTruthy(match)) return null;
  const scale = { KB: 1 / 1024, MB: 1, GB: 1024 }[match[2] ?? "MB"] ?? 1;
  return Math.round(Number(match[1]) * scale);
});
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
const settle = Effect.fn("eval.settle")(function* () {
  for (let round = 0; round < 3; round++) {
    globalThis.gc?.();
    // Native callback heartbeat/debounce timing remains at the protocol boundary.
    // Callback-to-Promise handshake for the native caller; cleanup stays at this protocol boundary.
    yield* Effect.sleep(300);
  }
  return yield* footprint("phys_footprint");
});

const sentence = "배포는 화요일과 목요일 오후에만 하기로 했고 로그 포맷은 logfmt로 바꿨다. ";
/** About `tokens` tokens of Korean text. */
const textOfTokens = (tokens: number) => sentence.repeat(Math.ceil(tokens / 20));

// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
const kiwi = Effect.fn("eval.kiwi")(function* (options: {
  loadMultiDict: boolean;
  loadTypoDict: boolean;
}) {
  const directory = join(home, "models", `kiwi-${kiwiModel.version}`, kiwiModel.directory);
  const wasm = join(dirname(runtimeRequire().resolve("kiwi-nlp")), "kiwi-wasm.wasm");
  const builder = yield* nativePromise(() => KiwiBuilder.create(wasm));
  const fs = yield* FileSystem.FileSystem;
  const modelFiles = Object.fromEntries(
    yield* Effect.forEach(
      yield* fs.readDirectory(directory),
      Effect.fnUntraced(function* (name) {
        return [name, yield* fs.readFile(join(directory, name))] as const;
      }),
    ),
  );
  const instance = yield* nativePromise(() =>
    builder.build({ modelFiles, modelType: "cong", ...options }),
  );
  instance.tokenize(sentence.repeat(50));
  return {};
});

/** Embeds through the app's Embedder, then disposes it and reports what memory came back. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
const embed = Effect.fn("eval.embed")(function* (variant: ModelVariant, texts: readonly string[]) {
  const afterEmbedMB = yield* Effect.gen(function* () {
    const services = yield* Layer.build(
      Embedder.localVariant(variant).pipe(Layer.provide(StorageRoot.layer(home))),
    );
    yield* Effect.provideContext(
      Effect.flatMap(Embedder, (embedder) => embedder.embed(texts)),
      services,
    );
    return yield* settle();
  }).pipe(Effect.scoped);
  return { afterEmbedMB, afterReleaseMB: yield* settle() };
});

const mixed = [textOfTokens(8000), ...Array.from({ length: 15 }, () => textOfTokens(60))];
const short = Array.from({ length: 16 }, () => textOfTokens(60));

const scenarios = {
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  "node baseline": () => Effect.succeed({}),
  "kiwi cong (as used)": () => kiwi({ loadMultiDict: true, loadTypoDict: true }),
  "kiwi without multi/typo dict": () => kiwi({ loadMultiDict: false, loadTypoDict: false }),
  "embedder fp32, 16 short": () => embed("fp32", short),
  "embedder fp32, 1 long + 15 short": () => embed("fp32", mixed),
  "embedder quint8, 16 short": () => embed("quint8", short),
  "embedder quint8, 1 long + 15 short": () => embed("quint8", mixed),
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  "embedder quint8, three reloads": Effect.fn("eval.reloads")(function* () {
    const rounds = [];
    for (let round = 0; round < 3; round++) rounds.push(yield* embed("quint8", short));
    return { rounds };
  }),
};

const only = process.argv[2];
if (isTruthy(only)) {
  const scenario = Object.entries(scenarios).find(([name]) => name === only)?.[1];
  if (!isTruthy(scenario)) throw new Error(`unknown scenario: ${only}`);
  const [elapsed, { details, peakMB }] = await runOAuthNodeEffect<
    [Duration.Duration, { details: object; peakMB: number | null }],
    Effect.Error<ReturnType<(typeof scenarios)[keyof typeof scenarios]>>
  >(
    Effect.timed(
      Effect.gen(function* () {
        const details: object = yield* scenario();
        return { details, peakMB: yield* footprint("phys_footprint_peak") };
      }),
    ),
  );
  // Native stdout/stderr or SDK logging boundary preserves the existing output format.
  Effect.runSync(
    Console.log(
      JSON.stringify({
        scenario: only,
        peakMB,
        ...details,
        ms: Math.round(Duration.toMillis(elapsed)),
      }),
    ),
  );
} else {
  const script = await runNativeEffect(path.fromFileUrl(new URL(import.meta.url)));
  for (const name of Object.keys(scenarios)) {
    try {
      const result = await runProcess({
        command: process.execPath,
        args: [...process.execArgv, script, name],
      });
      const line = result.stdout.trim().split("\n").at(-1) ?? "";
      Effect.runSync(Console.log(line));
    } catch (error) {
      Effect.runSync(
        Console.log(`${name}: failed (${error instanceof Error ? error.message : "unknown"})`),
      );
    }
  }
}
