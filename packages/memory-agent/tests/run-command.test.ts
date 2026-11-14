import { Effect, FileSystem, Path } from "effect";
import { expect } from "vite-plus/test";
import { ApprovedTools } from "../src/tools/approved.ts";
import { CallPlan } from "../src/tools/run-tool.ts";
import { callTool } from "./support/run-tools.ts";
import { TestEnv, testAgent } from "./support/test-env.ts";

testAgent()("run_command", (it) => {
  it.effect("only a script that looks runs without the approval and the gates", () =>
    Effect.gen(function* () {
      const { project, session } = yield* TestEnv;
      const approved = yield* ApprovedTools;
      const command = yield* Effect.fromNullishOr(
        approved
          .toolsFor({ ...project, permissionMode: "ask" }, session.id)
          .find(({ tool }) => tool.name === "run_command"),
      );
      expect(command.tool.needsApproval).toBe(true);
      const plan = yield* Effect.fromNullishOr(command.plan);
      const looking = { script: "git status --short", access: "read" };
      expect(yield* plan(looking)).toEqual(CallPlan.Ungated({ params: looking }));
      expect(yield* plan({ script: "pnpm test", access: "write" })).toEqual(CallPlan.AsGiven());
    }),
  );

  it.effect("refuses a script the file tools cover, and hosts for a script that only looks", () =>
    Effect.gen(function* () {
      const { project, session } = yield* TestEnv;
      const tools = (yield* ApprovedTools).toolsFor(project, session.id, "gate");
      expect(
        yield* Effect.flip(
          callTool(tools, "run_command", {
            script: "cat package.json | grep name",
            access: "read",
          }),
        ),
      ).toMatchObject({ message: expect.stringContaining("builtin_overlap") });
      expect(
        yield* Effect.flip(
          callTool(tools, "run_command", {
            script: "git fetch",
            access: "read",
            network: ["github.com"],
          }),
        ),
      ).toMatchObject({ message: expect.stringContaining("network_needs_write") });
    }),
  );

  // The sandbox runtime needs bubblewrap and socat on Linux; macOS has everything built in.
  it.effect.skipIf(process.platform !== "darwin")(
    "a script that looks reads the project but cannot change it or read its credential-named files",
    () =>
      Effect.gen(function* () {
        const { project, session } = yield* TestEnv;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tools = (yield* ApprovedTools).toolsFor(project, session.id, "gate");
        yield* fs.writeFileString(path.join(project.root, "notes.txt"), "four\n");
        yield* fs.writeFileString(path.join(project.root, ".env"), "TOKEN=1\n");
        yield* fs.makeDirectory(path.join(project.root, "config"));
        yield* fs.writeFileString(path.join(project.root, "config", "Aws-Credentials.json"), "{}");
        const result = yield* callTool(tools, "run_command", {
          script: [
            "wc -c < notes.txt",
            "echo x > probe.txt",
            "wc -c < .env",
            "wc -c < config/Aws-Credentials.json",
            "echo x > /tmp/run-command-probe-$$ && rm /tmp/run-command-probe-$$ && echo tmp ok",
          ].join("\n"),
          access: "read",
        });
        expect(result).toMatchObject({
          command: "wc -c < notes.txt",
          stdout: expect.stringMatching(/^\s*5\ntmp ok\n$/),
          stderr: expect.stringMatching(
            /probe\.txt: Operation not permitted[\s\S]*\.env: Operation not permitted[\s\S]*Aws-Credentials\.json: Operation not permitted/,
          ),
        });
        expect(yield* fs.exists(path.join(project.root, "probe.txt"))).toBe(false);
      }),
    { timeout: 30_000 },
  );

  it.effect.skipIf(process.platform !== "darwin")(
    "a script with write access changes the project",
    () =>
      Effect.gen(function* () {
        const { project, session } = yield* TestEnv;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tools = (yield* ApprovedTools).toolsFor(project, session.id, "gate");
        expect(
          yield* callTool(tools, "run_command", {
            script: "printf made > made.txt && printf done",
            access: "write",
          }),
        ).toMatchObject({ status: "succeeded", stdout: "done" });
        expect(yield* fs.readFileString(path.join(project.root, "made.txt"))).toBe("made");
      }),
    { timeout: 30_000 },
  );
});
