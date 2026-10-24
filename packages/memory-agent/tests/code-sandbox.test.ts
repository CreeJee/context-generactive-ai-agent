import { layer } from "@effect/vitest";
import { Clock, Duration, Effect, Fiber, Schema } from "effect";
import { expect } from "vite-plus/test";
import {
  CodeSandbox,
  ProgramCallFailed,
  type ProgramFunction,
  type ProgramOutcome,
} from "../src/code/sandbox.ts";
import type { JsonValue } from "../src/json.ts";

const run = (
  code: string,
  functions: Record<string, ProgramFunction> = {},
  timeout = Duration.seconds(10),
  input: JsonValue = null,
) =>
  Effect.gen(function* () {
    const sandbox = yield* CodeSandbox;
    return yield* sandbox.run({ code, input }, functions, timeout);
  });

const decodeValue = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
/** The value a program returned; any other outcome comes back whole, so a failed match shows it. */
const valueOf = (outcome: ProgramOutcome) =>
  outcome._tag === "Returned" && outcome.value !== undefined
    ? decodeValue(outcome.value)
    : Effect.succeed(outcome);

layer(CodeSandbox.layer, { excludeTestServices: true })("code sandbox", (it) => {
  it.effect("runs TypeScript that calls its functions at once and returns a value", () =>
    Effect.gen(function* () {
      const outcome = yield* run(
        `
          type Point = { x: number };
          const points: Point[] = await Promise.all(
            input.xs.map((x: number) => external_double({ x })),
          );
          console.log("points", points.length);
          return points.map((point) => point.x);
        `,
        {
          double: (args) =>
            Schema.decodeUnknownEffect(Schema.Struct({ x: Schema.Finite }))(args).pipe(
              Effect.map(({ x }) => ({ x: x * 2 })),
              Effect.orDie,
            ),
        },
        Duration.seconds(10),
        { xs: [1, 2, 3] },
      );
      expect(yield* valueOf(outcome)).toEqual([2, 4, 6]);
      expect(outcome.logs).toEqual(["points 3"]);
    }),
  );

  it.effect("reaches no files, network, processes or timers", () =>
    Effect.gen(function* () {
      const outcome = yield* run(
        `return [typeof require, typeof process, typeof fetch, typeof setTimeout, typeof import.meta]`,
      );
      // `import.meta` is not valid in a script, so the program does not even parse.
      expect(outcome._tag).toBe("Threw");
      const globals = yield* run(
        `return [typeof require, typeof process, typeof fetch, typeof setTimeout, typeof globalThis.Deno]`,
      );
      expect(yield* valueOf(globals)).toEqual([
        "undefined",
        "undefined",
        "undefined",
        "undefined",
        "undefined",
      ]);
    }),
  );

  it.effect("stops a busy program at its time without holding up this thread", () =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      const program = yield* Effect.forkChild(run(`while (true) {}`, {}, Duration.millis(800)));
      // A timer on this thread still fires while the program spins in its worker.
      yield* Effect.sleep(Duration.millis(100));
      const ticked = (yield* Clock.currentTimeMillis) - started;
      const outcome = yield* Fiber.join(program);
      expect(ticked).toBeLessThan(700);
      expect(outcome._tag).toBe("Threw");
      expect(outcome._tag === "Threw" && outcome.message).toBe("interrupted");
    }),
  );

  it.effect("a failed call throws in the program, where it can be caught", () =>
    Effect.gen(function* () {
      const outcome = yield* run(
        `
          const caught = await external_read({}).catch((error) => error.message);
          let missing = "";
          try {
            await external_gone({});
          } catch (error) {
            missing = error.message;
          }
          return { caught, missing };
        `,
        { read: () => Effect.fail(ProgramCallFailed.make({ message: "not_found: a.txt" })) },
      );
      expect(yield* valueOf(outcome)).toEqual({
        caught: "not_found: a.txt",
        missing: "'external_gone' is not defined",
      });
    }),
  );

  it.effect("reports a syntax error and a thrown error at the program's own line", () =>
    Effect.gen(function* () {
      const syntax = yield* run(`const a = 1;\nconst b = ;`);
      expect(syntax._tag === "Threw" && [syntax.name, syntax.line]).toEqual(["SyntaxError", 2]);
      const thrown = yield* run(`const a = 1;\n\nthrow new TypeError("boom");`);
      expect(thrown._tag === "Threw" && [thrown.name, thrown.message, thrown.line]).toEqual([
        "TypeError",
        "boom",
        3,
      ]);
    }),
  );

  it.effect("deep recursion fails the program, not the server", () =>
    Effect.gen(function* () {
      const outcome = yield* run(
        `function f(n: number): number { return f(n + 1) + 1 }\nreturn f(0)`,
      );
      expect(outcome._tag === "Threw" && outcome.message).toBe("stack overflow");
      expect(yield* valueOf(yield* run(`return 1 + 1`))).toBe(2);
    }),
  );
});
