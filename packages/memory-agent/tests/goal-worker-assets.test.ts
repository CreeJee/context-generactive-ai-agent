// Native worker threads and synchronous corruption fixtures exercise the owner snapshot boundary.
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MessageChannel, Worker } from "node:worker_threads";
import { Effect, Option, Schema } from "effect";
import { it } from "@effect/vitest";
import { expect, test, vi } from "vite-plus/test";

import { makeGoalWorkerAssetsRegistry } from "../src/agent/goal-worker-assets.ts";

const WorkerMessage = Schema.Struct({ type: Schema.String });
type WorkerMessage = typeof WorkerMessage.Type;
const workerMessage = Schema.decodeUnknownOption(WorkerMessage);

const boot = Effect.fn("bootGoalWorker")(function* (url: URL) {
  const { port1, port2 } = new MessageChannel();
  yield* Effect.addFinalizer(() => Effect.sync(() => port1.close()));
  const worker = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new Worker(url, {
          workerData: {
            port: port2,
            capability: {},
            turn: { messages: [] },
            tools: [],
            middleware: [],
            adapter: { name: "test", model: "test" },
            lastOperationId: 0,
          },
          transferList: [port2],
        }),
    ),
    (worker) => Effect.tryPromise(() => worker.terminate()).pipe(Effect.orDie),
  );
  return yield* Effect.callback<string>((resume) => {
    const onRpc = () => resume(Effect.succeed("rpc"));
    const onError = (error: Error) => resume(Effect.succeed(error.message));
    const onMessage = (message: WorkerMessage) => {
      const decoded = workerMessage(message);
      if (Option.isSome(decoded) && decoded.value.type === "failed") {
        resume(Effect.succeed("failed"));
      } else worker.postMessage({ type: "ack" });
    };
    port1.once("message", onRpc);
    worker.once("error", onError);
    worker.on("message", onMessage);
    return Effect.sync(() => {
      port1.off("message", onRpc);
      worker.off("error", onError);
      worker.off("message", onMessage);
    });
  }).pipe(Effect.timeout("10 seconds"));
}, Effect.scoped);

it.live(
  "runtime defaults capture the actual SDK and cold adoption needs no replacement runtime",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = mkdtempSync(join(tmpdir(), "goal-assets-runtime-"));
        const registry = makeGoalWorkerAssetsRegistry({ temporaryDirectory: directory });
        const reopened = makeGoalWorkerAssetsRegistry({ temporaryDirectory: directory });
        try {
          const assets = registry.resolve("runtime-default-goal");
          expect(yield* boot(assets.workerUrl)).toBe("rpc");
          yield* Effect.sync(() =>
            vi.stubEnv("CONTEXT_AGENT_RUNTIME", join(directory, "missing-runtime")),
          );
          const adopted = reopened.adopt(assets);
          expect(adopted.sourceGeneration).toBe(assets.sourceGeneration);
          expect(adopted.manifestHash).toBe(assets.manifestHash);
          expect(reopened.resolve(assets.goalInstanceId)).toBe(adopted);
          expect(yield* boot(adopted.workerUrl)).toBe("rpc");
          expect(() => reopened.resolve("new-goal-with-missing-runtime")).toThrow();
          expect(reopened.resolve(assets.goalInstanceId)).toBe(adopted);
        } finally {
          vi.unstubAllEnvs();
          reopened.dispose({ remove: true });
          registry.dispose({ remove: true });
          rmSync(directory, { recursive: true, force: true });
        }
      }),
    ),
);

it.live(
  "actual full-loop worker late-first import freezes codec, RPC and Effect support for an existing Goal",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = mkdtempSync(join(tmpdir(), "goal-assets-test-"));
        const source = join(directory, "source");
        cpSync(fileURLToPath(new URL("../src/agent/", import.meta.url)), source, {
          recursive: true,
        });
        const support = join(directory, "support");
        cpSync(fileURLToPath(new URL("../src/runtime/", import.meta.url)), support, {
          recursive: true,
        });
        const registry = makeGoalWorkerAssetsRegistry({
          sourceDirectory: source,
          supportDirectory: support,
        });
        try {
          const old = registry.resolve("goal-a");
          const canonical = old.workerUrl.href;
          old.workerUrl.pathname = "/not-the-worker.mjs";
          expect(old.workerUrl.href).toBe(canonical);
          const lease = registry.use(old);
          const second = registry.use(old);
          expect(() => registry.dispose()).toThrow("still active");
          lease.release();
          lease.release();
          expect(() => registry.dispose()).toThrow("still active");
          second.release();
          expect(registry.resolve("goal-a")).toBe(old);
          expect(() => registry.use({ ...old })).toThrow("Unregistered");
          for (const path of [
            join(source, "full-loop-codec.ts"),
            join(source, "full-loop-rpc-client.ts"),
            join(support, "native-effect.ts"),
            join(support, "native-stream.ts"),
          ]) {
            writeFileSync(
              path,
              readFileSync(path, "utf8") + '\nthrow new Error("new-source-marker");\n',
            );
          }
          // No worker imported the snapshot before the live files changed.
          expect(yield* boot(old.workerUrl)).toBe("rpc");
          expect(registry.resolve("goal-a")).toBe(old);
          const next = registry.resolve("goal-b");
          expect(next.sourceGeneration).not.toBe(old.sourceGeneration);
          expect(next.manifestHash).not.toBe(old.manifestHash);
          expect(yield* boot(next.workerUrl)).toBe("new-source-marker");
          expect(yield* boot(registry.resolve("goal-a").workerUrl)).toBe("rpc");
        } finally {
          registry.dispose({ remove: true });
          rmSync(directory, { recursive: true, force: true });
        }
      }),
    ),
  30000,
);

it.live(
  "actual SDK bytes are frozen per Goal, not a mutable node_modules symlink",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = mkdtempSync(join(tmpdir(), "goal-sdk-test-"));
        const seed = makeGoalWorkerAssetsRegistry();
        let registry: ReturnType<typeof makeGoalWorkerAssetsRegistry> | undefined;
        try {
          const initial = seed.resolve("seed");
          expect(yield* boot(initial.workerUrl)).toBe("rpc");
          const frozenSdk = realpathSync(
            fileURLToPath(new URL("./node_modules/@tanstack/ai", initial.workerUrl)),
          );
          const fixture = join(directory, "sdk");
          cpSync(frozenSdk, fixture, { recursive: true });
          const entry = join(fixture, "dist/esm/index.js");
          registry = makeGoalWorkerAssetsRegistry({ sdkEntry: entry });
          const old = registry.resolve("old");
          chmodSync(entry, 0o600);
          writeFileSync(
            entry,
            readFileSync(entry, "utf8") + '\nthrow new Error("sdk-generation-marker");\n',
          );
          expect(yield* boot(old.workerUrl)).toBe("rpc");
          expect(yield* boot(registry.resolve("new").workerUrl)).toBe("sdk-generation-marker");
          expect(yield* boot(registry.resolve("old").workerUrl)).toBe("rpc");
        } finally {
          registry?.dispose({ remove: true });
          seed.dispose({ remove: true });
          rmSync(directory, { recursive: true, force: true });
        }
      }),
    ),
  30000,
);

it.live(
  "cold owner adopts original snapshot after shutdown and never trusts mutable saved URL",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const original = makeGoalWorkerAssetsRegistry();
        const replacement = makeGoalWorkerAssetsRegistry({ sdkEntry: "/missing/live/sdk" });
        try {
          const asset = original.resolve("completed-goal");
          const saved = {
            goalInstanceId: asset.goalInstanceId,
            sourceGeneration: asset.sourceGeneration,
            manifestHash: asset.manifestHash,
            canonicalWorkerUrl: asset.canonicalWorkerUrl,
          };
          original.dispose();
          const adopted = replacement.adopt(saved);
          saved.canonicalWorkerUrl = "file:///wrong.mjs";
          expect(adopted.workerUrl.href).toBe(asset.canonicalWorkerUrl);
          expect(replacement.resolve("completed-goal")).toBe(adopted);
          const lease = replacement.use(adopted);
          try {
            expect(yield* boot(lease.assets.workerUrl)).toBe("rpc");
          } finally {
            lease.release();
          }
          expect(() => replacement.adopt({ ...adopted, goalInstanceId: "other" })).toThrow();
          expect(() => replacement.adopt({ ...adopted, manifestHash: "wrong" })).toThrow();
        } finally {
          replacement.dispose({ remove: true });
          original.dispose({ remove: true });
        }
      }),
    ),
  30000,
);

test.each([
  "bytes",
  "missing",
  "manifest",
  "extra",
  "escape-link",
  "internal-link",
  "deleted-root",
])(
  "cold adoption rejects %s corruption without capturing replacement",
  (corruption) => {
    const original = makeGoalWorkerAssetsRegistry();
    const replacement = makeGoalWorkerAssetsRegistry({ sdkEntry: "/missing/live/sdk" });
    try {
      const asset = original.resolve("g");
      const worker = fileURLToPath(asset.workerUrl);
      const destination = join(worker, "../..");
      original.dispose();
      if (corruption === "bytes") {
        chmodSync(worker, 0o600);
        writeFileSync(worker, "tampered");
      } else if (corruption === "missing") rmSync(worker);
      else if (corruption === "manifest") {
        const manifest = join(destination, "goal-assets-manifest.json");
        chmodSync(manifest, 0o600);
        writeFileSync(manifest, "{}");
      } else if (corruption === "extra") writeFileSync(join(destination, "extra"), "extra");
      else if (corruption === "deleted-root") rmSync(destination, { recursive: true, force: true });
      else {
        const link = join(destination, "worker/node_modules/@tanstack/ai");
        rmSync(link);
        symlinkSync(corruption === "escape-link" ? tmpdir() : join(destination, "worker"), link);
      }
      expect(() => replacement.adopt(asset)).toThrow();
      expect(() => replacement.verify(asset)).toThrow();
    } finally {
      replacement.dispose({ remove: true });
      original.dispose({ remove: true });
    }
  },
  30000,
);

test("capture race fails closed and a clean retry publishes only the new snapshot", () => {
  const directory = mkdtempSync(join(tmpdir(), "goal-assets-race-"));
  const sdk = join(directory, "sdk");
  cpSync(fileURLToPath(new URL("../src/agent/", import.meta.url)), sdk, { recursive: true });
  const entry = join(sdk, "full-loop-worker.ts");
  writeFileSync(join(sdk, "package.json"), "{}");
  let changed = false;
  const registry = makeGoalWorkerAssetsRegistry({
    sourceDirectory: sdk,
    sdkEntry: entry,
    readFile: (path) => {
      const bytes = readFileSync(path);
      if (path === entry && !changed) {
        changed = true;
        writeFileSync(entry, bytes.toString("utf8") + "\n// deterministic changed source\n");
      }
      return bytes;
    },
  });
  try {
    expect(() => registry.resolve("g")).toThrow("sources changed during capture");
    const assets = registry.resolve("g");
    expect(registry.resolve("g")).toBe(assets);
  } finally {
    registry.dispose({ remove: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each(["../escape", "/absolute", "@scope/../../escape", "valid/extra", ".hidden"])(
  "dependency name %s is rejected before filesystem resolution",
  (name) => {
    const directory = mkdtempSync(join(tmpdir(), "goal-assets-name-"));
    cpSync(fileURLToPath(new URL("../src/agent/", import.meta.url)), directory, {
      recursive: true,
    });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ dependencies: { [name]: "1" } }),
    );
    const registry = makeGoalWorkerAssetsRegistry({
      sdkEntry: join(directory, "full-loop-worker.ts"),
    });
    try {
      expect(() => registry.resolve("g")).toThrow("Invalid SDK dependency name");
    } finally {
      registry.dispose({ remove: true });
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("missing SDK dependency rejects capture without publishing a Goal asset", () => {
  const directory = mkdtempSync(join(tmpdir(), "goal-assets-missing-"));
  const sdk = join(directory, "sdk");
  cpSync(fileURLToPath(new URL("../src/agent/", import.meta.url)), sdk, { recursive: true });
  writeFileSync(
    join(sdk, "package.json"),
    JSON.stringify({ dependencies: { "unavailable-goal-test-dependency": "1" } }),
  );
  const registry = makeGoalWorkerAssetsRegistry({ sdkEntry: join(sdk, "full-loop-worker.ts") });
  try {
    expect(() => registry.resolve("g")).toThrow("Unavailable SDK dependency");
  } finally {
    registry.dispose({ remove: true });
    rmSync(directory, { recursive: true, force: true });
  }
});
