// Separate native Node processes verify import/require without sharing poisoned browser globals.
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Path } from "effect";
import { it } from "@effect/vitest";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect } from "vite-plus/test";

// Node exposes storage getters even without a browser. SSR must not probe them.
for (const mode of ["import", "require"])
  it.live(`${mode} does not read browser storage during SSR`, () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(NodeServices.layer);
      const result = yield* Effect.provideContext(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const path = yield* Path.Path;
          const cwd = yield* path.fromFileUrl(new URL("../..", import.meta.url));
          return yield* spawner.exitCode(
            ChildProcess.make(
              process.execPath,
              [
                "--input-type=module",
                "-e",
                `
        import { createRequire } from "node:module";
        let reads = 0;
        for (const key of ["localStorage", "sessionStorage"])
          Object.defineProperty(globalThis, key, {
            configurable: true,
            get() { reads++; throw new Error("Browser storage accessed during SSR"); }
          });
        const hooks = ${mode === "import" ? 'await import("react-simplikit")' : 'createRequire(import.meta.url)("react-simplikit")'};
        if (typeof hooks.useLoading !== "function" || reads !== 0)
          throw new Error("SSR storage reads: " + reads);
      `,
              ],
              { cwd, stderr: "inherit" },
            ),
          );
        }),
        context,
      );
      expect(result).toBe(0);
    }),
  );
