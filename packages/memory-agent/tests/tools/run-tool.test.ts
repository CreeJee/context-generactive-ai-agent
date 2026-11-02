import { it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import { describe, expect } from "vite-plus/test";
import { PathRejected } from "../../src/files/paths.ts";
import { guardedEffect } from "../../src/tools/failure.ts";
import { runTool } from "../../src/tools/run-tool.ts";

/**
 * A call's result and failure reach the model as they did through TanStack
 * (docs/effect-ai-migration.md step 3).
 */

const callWith = <A, E>(handler: () => Effect.Effect<A, E>) =>
  runTool({
    name: "read_file",
    description: "Read a file.",
    parameters: Schema.Struct({ path: Schema.String }),
    handler,
  })
    .prepare({ path: "a" })
    .pipe(Effect.flatMap((run) => run({ toolCallId: "call-1" })));

describe("run tool", () => {
  it.effect("gives the result as the JSON TanStack stored", () =>
    Effect.gen(function* () {
      expect(
        yield* callWith(() => Effect.succeed({ lines: 2, next: undefined, skipped: [undefined] })),
      ).toEqual({ lines: 2, skipped: [null] });
      expect(yield* callWith(() => Effect.succeed('{"lines":2}'))).toEqual({ lines: 2 });
      expect(yield* callWith(() => Effect.succeed("plain text"))).toBe("plain text");
      expect(yield* callWith(() => Effect.void)).toBeNull();
    }),
  );

  it.effect("fails a call with what the model reads, and keeps a cancelled call cancelled", () =>
    Effect.gen(function* () {
      const rejected = yield* Effect.flip(
        callWith(() =>
          guardedEffect("src/a.ts", PathRejected.make({ path: "src/a.ts", reason: "not_found" })),
        ),
      );
      expect(rejected).toMatchObject({
        code: "not_found",
        tag: "PathRejected",
        detail: "src/a.ts. Nothing exists at that path.",
      });
      const thrown = yield* Effect.flip(callWith(() => Effect.die(new Error("no_match: a"))));
      expect(thrown).toMatchObject({ code: "no_match", tag: "Error", detail: "a" });
      const cancelled = yield* Effect.exit(callWith(() => Effect.interrupt));
      expect(Exit.hasInterrupts(cancelled)).toBe(true);
    }),
  );
});
