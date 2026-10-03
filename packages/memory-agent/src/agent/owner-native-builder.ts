import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { Context, Effect, Layer } from "effect";
import { runtimeRequire } from "../runtime/resources.ts";
import { OwnerNativeFiles } from "./owner-native-files.ts";
import { NativeRegistrationError } from "./owner-native-error.ts";

export const nativeDigest = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const buildNative = Effect.fn("OwnerNativeBuilder.build")(function* (
  entry: string,
  files: OwnerNativeFiles["Service"],
) {
  const context = yield* Effect.context<never>();
  const sources = new Map<string, string>();
  const allowed = new Set([
    "effect",
    "@tanstack/ai",
    "@secretlint/core",
    "@secretlint/profiler",
    "@secretlint/secretlint-rule-preset-recommend",
  ]);
  // Vite and its transform callback are the only Promise interoperability boundary.
  const result = yield* Effect.tryPromise({
    try: async (signal) => {
      const builderUrl = pathToFileURL(runtimeRequire().resolve("vite")).href;
      const { build }: typeof import("vite") = await import(/* @vite-ignore */ builderUrl);
      return build({
        configFile: false,
        root: dirname(entry),
        logLevel: "silent",
        plugins: [
          {
            name: "owner-native-provenance",
            async transform(_code, id) {
              if (id.startsWith("/") && !id.includes("?"))
                sources.set(
                  id,
                  nativeDigest(await Effect.runPromiseWith(context)(files.read(id), { signal })),
                );
            },
          },
        ],
        build: {
          write: false,
          minify: false,
          lib: { entry, formats: ["es"] },
          rollupOptions: {
            external: (id) => {
              if (id.startsWith("node:")) return true;
              if (id.startsWith(".") || id.startsWith("/") || id.startsWith("\0")) return false;
              const name = id.startsWith("@")
                ? id.split("/").slice(0, 2).join("/")
                : id.split("/")[0];
              if (!allowed.has(name)) throw new Error("Unsupported native dependency");
              return true;
            },
          },
        },
      });
    },
    catch: (cause) => new NativeRegistrationError({ cause }),
  });
  const code = yield* Effect.try({
    try: () => {
      const outputs = Array.isArray(result) ? result : [result];
      if (outputs.length !== 1) throw new Error("Expected single native bundle");
      // SAFETY: finite Vite build with write:false returns RollupOutput, never a watcher.
      const chunks = (outputs[0] as { output: Array<{ type: string; code?: string }> }).output;
      if (chunks.length !== 1 || chunks[0].type !== "chunk" || chunks[0].code === undefined)
        throw new Error("Native assets not portable");
      if (sources.size === 0) throw new Error("Missing build provenance");
      return chunks[0].code;
    },
    catch: (cause) => new NativeRegistrationError({ cause }),
  });
  for (const [path, hash] of sources) {
    if (nativeDigest(yield* files.read(path)) !== hash)
      return yield* new NativeRegistrationError({
        cause: new Error("Native sources changed during build"),
      });
  }
  return {
    code,
    sourceHash: nativeDigest(JSON.stringify([...sources].sort(([a], [b]) => a.localeCompare(b)))),
  };
});
export class OwnerNativeBuilder extends Context.Service<
  OwnerNativeBuilder,
  {
    readonly build: (
      entry: string,
    ) => Effect.Effect<{ code: string; sourceHash: string }, NativeRegistrationError>;
  }
>()("memory-agent/agent/OwnerNativeBuilder") {
  static readonly make = (files: OwnerNativeFiles["Service"]) => ({
    build: (entry: string) => buildNative(entry, files),
  });
  static readonly layer = Layer.effect(
    OwnerNativeBuilder,
    Effect.map(OwnerNativeFiles, OwnerNativeBuilder.make),
  );
}
