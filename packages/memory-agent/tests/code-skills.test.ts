import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, FileSystem, HashSet, Option, Path, Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import { NetAddress } from "effect/net";
import { StorageRoot } from "../src/config/storage-root.ts";
import { expect, test } from "vite-plus/test";
import { builtinOverlap } from "../src/skills/code-skills.ts";
import { ApprovedTools } from "../src/tools/approved.ts";
import { CodeTools } from "../src/tools/code.ts";
import { runTool } from "../src/tools/run-tool.ts";
import { TestEnv, testAgent } from "./support/test-env.ts";
import { callTool } from "./support/run-tools.ts";

const portOf = (address: NetAddress.SocketAddress) =>
  Effect.succeed(address).pipe(
    Effect.filterOrElse(NetAddress.isInetAddress, () =>
      Effect.die("the test server listens on TCP"),
    ),
    Effect.map((inet) => inet.port),
  );

test("a script that only wraps built-in tools is refused, a filter after a build is not", () => {
  expect(Option.isSome(builtinOverlap("rg -n TODO src"))).toBe(true);
  expect(Option.isSome(builtinOverlap("cd packages/app && ls -la\ncat package.json"))).toBe(true);
  expect(Option.isNone(builtinOverlap("pnpm test 2>&1 | tail -50"))).toBe(true);
  expect(Option.isNone(builtinOverlap("git log --oneline -20"))).toBe(true);
});

testAgent()("code skills", (it) => {
  it.effect("an approved script runs with its arguments; an edited one is refused", () =>
    Effect.gen(function* () {
      const { project } = yield* TestEnv;
      const tools = (yield* ApprovedTools).toolsFor(project, "gate");
      yield* callTool(tools, "save_code_skill", {
        name: "echo-args",
        description: "Print the arguments",
        program: { runtime: "sh", script: 'printf "%s|" "$@"' },
      });
      expect(
        yield* callTool(tools, "run_skill", {
          name: "echo-args",
          args: ["a b", "$(whoami)", "it's"],
        }),
      ).toMatchObject({ status: "succeeded", stdout: "a b|$(whoami)|it's|" });

      // A file tool edit needs no approval, so the edited script must not run.
      const path = yield* Path.Path;
      yield* (yield* FileSystem.FileSystem).writeFileString(
        path.join(project.root, ".agents/skills/echo-args/scripts/run.sh"),
        "printf changed\n",
      );
      expect(yield* Effect.flip(callTool(tools, "run_skill", { name: "echo-args" }))).toMatchObject(
        {
          message: expect.stringContaining("not_approved"),
        },
      );

      const full = (yield* ApprovedTools).toolsFor({ ...project, permissionMode: "full" }, "gate");
      expect(yield* callTool(full, "run_skill", { name: "echo-args" })).toMatchObject({
        stdout: "changed",
      });
    }),
  );

  it.effect("run_skill runs ts skills over the run's tools, and sh skills; a program cannot", () =>
    Effect.gen(function* () {
      const { project } = yield* TestEnv;
      const tools = (yield* ApprovedTools).toolsFor(project, "gate");
      const [, run] = tools;
      const echo = runTool({
        name: "echo_text",
        description: "echo_text",
        parameters: Schema.Struct({ text: Schema.String }),
        handler: ({ text }) => Effect.succeed({ text }),
      });
      const sh = yield* Effect.fromNullishOr(run);
      const runSkill = [
        (yield* CodeTools).forRunTools([echo, sh], HashSet.empty()).codeSkills(project, sh),
      ];
      expect(
        yield* callTool(tools, "save_code_skill", {
          name: "shout",
          description: "Echo a text in capitals",
          program: {
            runtime: "ts",
            code: "const { text } = await external_echo_text({ text: input.text.toUpperCase() });\nreturn text;",
            input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          },
        }),
      ).toMatchObject({ runtime: "ts", input: "{ text: string }" });
      yield* callTool(tools, "save_code_skill", {
        name: "echo-run",
        description: "Print the arguments",
        program: { runtime: "sh", script: 'printf "%s|" "$@"' },
      });
      expect(
        yield* callTool(runSkill, "run_skill", { name: "shout", input: { text: "hi" } }),
      ).toEqual({ status: "returned", value: "HI", logs: [] });
      expect(yield* Effect.flip(callTool(runSkill, "run_skill", { name: "shout" }))).toMatchObject({
        message: expect.stringContaining("invalid_input"),
      });
      expect(
        yield* callTool(runSkill, "run_skill", { name: "echo-run", args: ["a"] }),
      ).toMatchObject({
        status: "succeeded",
        stdout: "a|",
      });
      // What a program gets as external_run_skill runs sh skills only.
      expect(yield* Effect.flip(callTool(tools, "run_skill", { name: "shout" }))).toMatchObject({
        message: expect.stringContaining("ts_skill"),
      });
    }),
  );

  // The sandbox runtime needs bubblewrap and socat on Linux; macOS has everything built in.
  it.effect.skipIf(process.platform !== "darwin")(
    "a script reaches only its approved hosts and cannot write skills or read app storage",
    () =>
      Effect.gen(function* () {
        const { project } = yield* TestEnv;
        const storage = yield* StorageRoot;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tools = (yield* ApprovedTools).toolsFor(project, "gate");
        const server = yield* NodeHttpServer.make(NodeHttpServer.createServer, {
          port: 0,
          host: "127.0.0.1",
        });
        yield* server.serve(Effect.succeed(HttpServerResponse.text("reached")));
        const port = yield* portOf(server.address);
        const fetch = (network: readonly string[], proxied: boolean) =>
          Effect.gen(function* () {
            yield* callTool(tools, "save_code_skill", {
              name: "fetch-local",
              description: "Fetch the local test server",
              program: {
                runtime: "sh",
                // Loopback skips the proxy unless told otherwise; through it, it stands in for a host.
                script: `curl -fsS --max-time 5 ${proxied ? "--noproxy ''" : ""} "http://127.0.0.1:$1/"`,
                network,
              },
            });
            return yield* callTool(tools, "run_skill", {
              name: "fetch-local",
              args: [String(port)],
            });
          });

        expect(yield* fetch([], true)).toMatchObject({
          status: "failed",
          stderr: expect.stringContaining("<sandbox_violations>"),
        });
        expect(yield* fetch([`127.0.0.1:${port}`], true)).toMatchObject({
          status: "succeeded",
          stdout: "reached",
        });
        expect(yield* fetch([], false)).toMatchObject({ status: "failed" });
        expect(yield* fetch(["localhost"], false)).toMatchObject({
          status: "succeeded",
          stdout: "reached",
        });

        const secret = path.join(storage.path, "sandbox-probe.txt");
        yield* fs.writeFileString(secret, "secret\n");
        yield* callTool(tools, "save_code_skill", {
          name: "touch-around",
          description: "Write a skill file, then read the file named by $1",
          program: {
            runtime: "sh",
            script: 'echo x > .agents/skills/echo-args/SKILL.md; wc -c < "$1"',
          },
        });
        expect(
          yield* callTool(tools, "run_skill", { name: "touch-around", args: [secret] }),
        ).toMatchObject({
          status: "failed",
          stderr: expect.stringMatching(
            /SKILL\.md: Operation not permitted[\s\S]*sandbox-probe\.txt: Operation not permitted/,
          ),
        });
      }),
    // Five sandboxed runs, each starting its own worker and proxy.
    { timeout: 30_000 },
  );
});
