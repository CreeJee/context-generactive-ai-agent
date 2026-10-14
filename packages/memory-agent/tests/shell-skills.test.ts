import { Cause, Effect, FileSystem, Option, Path } from "effect";
import { expect, test } from "vite-plus/test";
import { builtinOverlap } from "../src/skills/shell-skills.ts";
import { ApprovedTools } from "../src/tools/approved.ts";
import { TestEnv, testAgent } from "./support/test-env.ts";
import { sdk } from "./agents/agent-env.ts";

const rejection = <A, R>(operation: Effect.Effect<A, Cause.UnknownError, R>) =>
  operation.pipe(
    Effect.flip,
    Effect.orDie,
    Effect.map((error) => error.cause),
  );

test("a script that only wraps built-in tools is refused, a filter after a build is not", () => {
  expect(Option.isSome(builtinOverlap("rg -n TODO src"))).toBe(true);
  expect(Option.isSome(builtinOverlap("cd packages/app && ls -la\ncat package.json"))).toBe(true);
  expect(Option.isNone(builtinOverlap("pnpm test 2>&1 | tail -50"))).toBe(true);
  expect(Option.isNone(builtinOverlap("git log --oneline -20"))).toBe(true);
});

testAgent()("shell skills", (it) => {
  it.effect("an approved script runs with its arguments; an edited one is refused", () =>
    Effect.gen(function* () {
      const { project } = yield* TestEnv;
      const [save, run] = (yield* ApprovedTools).forProject(project, "gate");
      yield* sdk(() =>
        save.execute!({
          name: "echo-args",
          description: "Print the arguments",
          script: 'printf "%s|" "$@"',
        }),
      );
      expect(
        yield* sdk(() => run.execute!({ name: "echo-args", args: ["a b", "$(whoami)", "it's"] })),
      ).toMatchObject({ status: "succeeded", stdout: "a b|$(whoami)|it's|" });

      // A file tool edit needs no approval, so the edited script must not run.
      const path = yield* Path.Path;
      yield* (yield* FileSystem.FileSystem).writeFileString(
        path.join(project.root, ".agents/skills/echo-args/scripts/run.sh"),
        "printf changed\n",
      );
      expect(yield* rejection(sdk(() => run.execute!({ name: "echo-args" })))).toMatchObject({
        message: expect.stringContaining("not_approved"),
      });

      const [, runFull] = (yield* ApprovedTools).forProject(
        { ...project, permissionMode: "full" },
        "gate",
      );
      expect(yield* sdk(() => runFull.execute!({ name: "echo-args" }))).toMatchObject({
        stdout: "changed",
      });
    }),
  );
});
