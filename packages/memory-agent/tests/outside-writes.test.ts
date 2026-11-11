import { Effect, FileSystem, Path, Schema } from "effect";
import { expect } from "vite-plus/test";
import type { JsonValue } from "../src/json.ts";
import { ApprovedTools } from "../src/tools/approved.ts";
import { CallPlan, type RunTool } from "../src/tools/run-tool.ts";
import { TestEnv, testAgent } from "./support/test-env.ts";
import { callTool, failureCode } from "./support/run-tools.ts";

const Written = Schema.Struct({ sha256: Schema.String });
const sha256Of = (result: JsonValue) =>
  Effect.map(Schema.decodeUnknownEffect(Written)(result), ({ sha256 }) => sha256);

/** How the loop would run a call of `name` with `params`, from the tool's plan. */
const planOf = (tools: ReadonlyArray<RunTool>, name: string, params: JsonValue) =>
  Effect.fromNullishOr(tools.find(({ tool }) => tool.name === name)?.plan).pipe(
    Effect.flatMap((plan) => plan(params)),
  );

testAgent()("outside writes into the project", (it) => {
  it.effect("run as the project file tools do, without asking", () =>
    Effect.gen(function* () {
      const { project } = yield* TestEnv;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tools = (yield* ApprovedTools).toolsFor(project, "static");
      const given = path.join(project.root, "notes", "a.md");

      // The call needs no approval and runs with the path write_file takes.
      expect(yield* planOf(tools, "write_outside_file", { path: given, content: "one\n" })).toEqual(
        CallPlan.Ungated({ params: { path: "notes/a.md", content: "one\n" } }),
      );
      expect(
        yield* planOf(tools, "write_outside_file", { path: "/elsewhere/a.md", content: "x" }),
      ).toEqual(CallPlan.AsGiven());

      const written = yield* callTool(tools, "write_outside_file", {
        path: "notes/a.md",
        content: "one\n",
      });
      expect(written).toMatchObject({
        path: "notes/a.md",
        created: true,
        insideProject: expect.stringContaining("write_file"),
      });
      expect(yield* fs.readFileString(given)).toBe("one\n");

      // An approved absolute path that is in the project is written there too.
      expect(
        yield* callTool(tools, "write_outside_file", {
          path: given,
          content: "two\n",
          expectedSha256: yield* sha256Of(written),
        }),
      ).toMatchObject({ path: "notes/a.md", created: false });
      expect(yield* fs.readFileString(given)).toBe("two\n");

      // The project's rules still apply.
      expect(
        yield* failureCode(
          callTool(tools, "write_outside_file", { path: ".git/config", content: "x" }),
        ),
      ).toBe("git_internal");
      expect(
        yield* failureCode(callTool(tools, "write_outside_file", { path: ".env", content: "x" })),
      ).toBe("credential");

      const created = yield* callTool(tools, "write_outside_file", {
        path: "notes/b.md",
        content: "b\n",
      });
      expect(
        yield* callTool(tools, "delete_outside_file", {
          path: path.join(project.root, "notes", "b.md"),
          expectedSha256: yield* sha256Of(created),
        }),
      ).toMatchObject({ path: "notes/b.md", deleted: true });
      expect(yield* fs.exists(path.join(project.root, "notes", "b.md"))).toBe(false);
    }),
  );

  it.effect("in a card, a path in the user's folder is written in the card's worktree", () =>
    Effect.gen(function* () {
      const { project } = yield* TestEnv;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const card = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "outside-writes-card-" }),
      );
      const tools = (yield* ApprovedTools).toolsFor(
        {
          ...project,
          root: card,
          toolFence: { deniedRoots: [project.root], userRoot: project.root },
        },
        "gate",
      );
      const given = path.join(project.root, "a.md");
      expect(yield* planOf(tools, "write_outside_file", { path: given, content: "c\n" })).toEqual(
        CallPlan.Ungated({ params: { path: "a.md", content: "c\n" } }),
      );
      yield* callTool(tools, "write_outside_file", { path: given, content: "c\n" });
      expect(yield* fs.readFileString(path.join(card, "a.md"))).toBe("c\n");
      expect(yield* fs.exists(given)).toBe(false);
    }),
  );
});
