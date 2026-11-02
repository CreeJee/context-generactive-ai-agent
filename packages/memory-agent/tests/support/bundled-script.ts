import { Effect } from "effect";
import { build } from "vite/rolldown";

/**
 * Bundles a child process's TypeScript script, with everything it imports, into the one ES module
 * `file`. Started from the bundle, a child loads one file instead of resolving and type-stripping
 * every module, which is most of its start-up time.
 */
export const bundleScript = Effect.fn("bundleScript")(function* (entry: string, file: string) {
  yield* Effect.tryPromise(() =>
    build({
      input: entry,
      platform: "node",
      logLevel: "warn",
      output: { file, format: "esm", codeSplitting: false },
    }),
  );
  return file;
});
