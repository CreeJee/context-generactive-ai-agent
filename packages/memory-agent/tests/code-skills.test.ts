import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { toolDefinition } from "@tanstack/ai";
import { Cause, Effect, FileSystem, HashSet, Option, Path, Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import { NetAddress } from "effect/net";
import { StorageRoot } from "../src/config/storage-root.ts";
import { expect, test } from "vite-plus/test";
import { builtinOverlap } from "../src/skills/code-skills.ts";
import { ApprovedTools } from "../src/tools/approved.ts";
import { CodeTools } from "../src/tools/code.ts";
import { toToolSchema } from "../src/tools/schema.ts";
import type { JsonValue } from "../src/json.ts";
import type { RunTool } from "../src/tools/run-tool.ts";
import { TestEnv, testAgent } from "./support/test-env.ts";
import { runToolRequestDifferences } from "./support/requests.ts";
import { inRun } from "./support/run-span.ts";
import { sdk } from "./agents/agent-env.ts";

const portOf = (address: NetAddress.SocketAddress) =>
  Effect.succeed(address).pipe(
    Effect.filterOrElse(NetAddress.isInetAddress, () =>
      Effect.die("the test server listens on TCP"),
    ),
    Effect.map((inet) => inet.port),
  );

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

const callOf = (tool: RunTool | undefined, params: JsonValue) =>
  Effect.fromNullishOr(tool).pipe(
    Effect.flatMap((found) => found.prepare(params)),
    Effect.flatMap((run) => run({ toolCallId: "call-1" })),
  );

testAgent()("code skills", (it) => {
  it.effect("the Effect AI tools ask as the TanStack ones and need approval as they did", () =>
    Effect.gen(function* () {
      const { project } = yield* TestEnv;
      const approved = yield* ApprovedTools;
      yield* Effect.forEach(["static", "gate"] as const, (approval) =>
        Effect.gen(function* () {
          const chatTools = yield* inRun(approved.forProject(project, approval));
          const runTools = approved.runToolsFor(project, approval);
          expect(yield* runToolRequestDifferences({ chatTools, runTools })).toEqual([
            undefined,
            undefined,
            undefined,
          ]);
          expect(runTools.map((tool) => tool.tool.needsApproval ?? false)).toEqual(
            chatTools.map((tool) => tool.needsApproval ?? false),
          );
        }),
      );
    }),
  );

  it.effect("an approved script runs with its arguments through its Effect AI tool", () =>
    Effect.gen(function* () {
      const { project } = yield* TestEnv;
      const [save, run] = (yield* ApprovedTools).runToolsFor(project, "gate");
      yield* callOf(save, {
        name: "echo-run",
        description: "Print the arguments",
        program: { runtime: "sh", script: 'printf "%s|" "$@"' },
      });
      expect(yield* callOf(run, { name: "echo-run", args: ["a b", "it's"] })).toMatchObject({
        status: "succeeded",
        stdout: "a b|it's|",
      });
    }),
  );

  it.effect("an approved script runs with its arguments; an edited one is refused", () =>
    Effect.gen(function* () {
      const { project } = yield* TestEnv;
      const [save, run] = yield* inRun((yield* ApprovedTools).forProject(project, "gate"));
      yield* sdk(() =>
        save.execute!({
          name: "echo-args",
          description: "Print the arguments",
          program: { runtime: "sh", script: 'printf "%s|" "$@"' },
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

      const [, runFull] = yield* inRun(
        (yield* ApprovedTools).forProject({ ...project, permissionMode: "full" }, "gate"),
      );
      expect(yield* sdk(() => runFull.execute!({ name: "echo-args" }))).toMatchObject({
        stdout: "changed",
      });
    }),
  );

  it.effect("a ts skill runs its program on checked input; a program cannot run one", () =>
    Effect.gen(function* () {
      const { project } = yield* TestEnv;
      const [save, run] = yield* inRun((yield* ApprovedTools).forProject(project, "gate"));
      const echo = toolDefinition({
        name: "echo_text",
        description: "echo_text",
        inputSchema: toToolSchema(Schema.Struct({ text: Schema.String })),
      }).server(({ text }) => ({ text }));
      const programs = yield* (yield* CodeTools).forTools([echo, run], HashSet.empty());
      const runSkill = programs.codeSkills(project, run);
      expect(
        yield* sdk(() =>
          save.execute!({
            name: "shout",
            description: "Echo a text in capitals",
            program: {
              runtime: "ts",
              code: "const { text } = await external_echo_text({ text: input.text.toUpperCase() });\nreturn text;",
              input: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
              },
            },
          }),
        ),
      ).toMatchObject({ runtime: "ts", input: "{ text: string }" });
      expect(yield* sdk(() => runSkill.execute!({ name: "shout", input: { text: "hi" } }))).toEqual(
        { status: "returned", value: "HI", logs: [] },
      );
      expect(yield* rejection(sdk(() => runSkill.execute!({ name: "shout" })))).toMatchObject({
        message: expect.stringContaining("invalid_input"),
      });
      // What a program gets as external_run_skill runs sh skills only.
      expect(yield* rejection(sdk(() => run.execute!({ name: "shout" })))).toMatchObject({
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
        const [save, run] = yield* inRun((yield* ApprovedTools).forProject(project, "gate"));
        const server = yield* NodeHttpServer.make(NodeHttpServer.createServer, {
          port: 0,
          host: "127.0.0.1",
        });
        yield* server.serve(Effect.succeed(HttpServerResponse.text("reached")));
        const port = yield* portOf(server.address);
        const fetch = (network: readonly string[], proxied: boolean) =>
          Effect.gen(function* () {
            yield* sdk(() =>
              save.execute!({
                name: "fetch-local",
                description: "Fetch the local test server",
                program: {
                  runtime: "sh",
                  // Loopback skips the proxy unless told otherwise; through it, it stands in for a host.
                  script: `curl -fsS --max-time 5 ${proxied ? "--noproxy ''" : ""} "http://127.0.0.1:$1/"`,
                  network,
                },
              }),
            );
            return yield* sdk(() => run.execute!({ name: "fetch-local", args: [String(port)] }));
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
        yield* sdk(() =>
          save.execute!({
            name: "touch-around",
            description: "Write a skill file, then read the file named by $1",
            program: {
              runtime: "sh",
              script: 'echo x > .agents/skills/echo-args/SKILL.md; wc -c < "$1"',
            },
          }),
        );
        expect(
          yield* sdk(() => run.execute!({ name: "touch-around", args: [secret] })),
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
