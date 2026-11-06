import { it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { withTestPlatform } from "./support/platform.ts";
import { afterEach, describe, expect, vi } from "vite-plus/test";
import { requireRuntime } from "../src/runtime/resources.ts";

afterEach(() => vi.unstubAllEnvs());
const tempDir = Effect.fn("runtimeTest.tempDir")(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "memory-agent-runtime-" }));
});

describe("runtime packages", () => {
  it.live(
    "load from the unpacked runtime folder when the executable names one, else from this package",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const runtime = yield* tempDir();
        yield* fs.makeDirectory(path.join(runtime, "node_modules", "turbovec"), {
          recursive: true,
        });
        yield* fs.writeFileString(
          path.join(runtime, "node_modules", "turbovec", "package.json"),
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            name: "turbovec",
            type: "module",
            exports: "./index.js",
          }),
        );
        yield* fs.writeFileString(
          path.join(runtime, "node_modules", "turbovec", "index.js"),
          'export const loadTurbovec = () => "from the runtime folder";',
        );
        const real = (yield* requireRuntime("turbovec")).loadTurbovec();
        expect(real.VectorIndex).toBeTypeOf("function");
        vi.stubEnv("CONTEXT_AGENT_RUNTIME", runtime);
        // The stand-in returns a marker string where the real addon returns its classes.
        expect((yield* requireRuntime("turbovec")).loadTurbovec()).toEqual(
          "from the runtime folder",
        );
      }).pipe(withTestPlatform),
  );
});
