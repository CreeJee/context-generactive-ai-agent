import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { Cause, Effect, FileSystem, ManagedRuntime, Schema } from "effect";
import { sha256 } from "../src/runtime/synchronous-crypto.ts";
import { path } from "../src/runtime/synchronous-path.ts";
const { dirname, join } = path;
import { fileURLToPath } from "node:url";
import { build } from "vite-plus/pack";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(packageRoot, "dist", "runtime");
const digest = sha256;

const runtime = ManagedRuntime.make(NodeFileSystem.layer);
await runtime.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    yield* fs.remove(output, { recursive: true, force: true });
    yield* fs.makeDirectory(output, { recursive: true });

    const entries = {
      native: join(packageRoot, "src", "agent", "native-artifact-entry.ts"),
      "full-loop-worker": join(packageRoot, "src", "agent", "full-loop-worker.ts"),
    } as const;

    for (const [name, entry] of Object.entries(entries)) {
      const config: Parameters<typeof build>[0] = {
        config: false,
        entry: { [name]: entry },
        outDir: output,
        clean: false,
        format: "esm",
        platform: "node",
        fixedExtension: true,
        dts: false,
        outputOptions: { codeSplitting: false },
        deps: { alwaysBundle: [/.*/], onlyBundle: false },
        report: false,
        logLevel: "warn",
      };
      if (name === "native")
        config.deps = {
          alwaysBundle: [/.*/],
          onlyBundle: false,
          neverBundle: [
            /^effect(?:\/.*)?$/,
            /^@tanstack\/ai(?:\/.*)?$/,
            /^@effect\/platform-node(?:\/.*)?$/,
          ],
        };
      yield* Effect.tryPromise({
        try: () => build(config),
        catch: (cause) => new Cause.UnknownError(cause),
      });
    }

    const native = yield* fs.readFile(join(output, "native.mjs"));
    const worker = yield* fs.readFile(join(output, "full-loop-worker.mjs"));
    const manifest = {
      version: 1,
      native: {
        file: "native.mjs",
        sha256: digest(native),
        sourceHash: digest(native),
        contractVersion: "native-factories/v1",
      },
      worker: {
        file: "full-loop-worker.mjs",
        sha256: digest(worker),
      },
    };
    yield* fs.writeFileString(
      join(output, "artifact-manifest.json"),
      `${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(manifest)}\n`,
    );
  }),
);

await runtime.dispose();
