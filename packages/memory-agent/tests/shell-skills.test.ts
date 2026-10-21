import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Cause, Effect, FileSystem, Option, Path } from "effect";
import { HttpServerResponse } from "effect/http";
import { NetAddress } from "effect/net";
import { StorageRoot } from "../src/config/storage-root.ts";
import { expect, test } from "vite-plus/test";
import { builtinOverlap } from "../src/skills/shell-skills.ts";
import { ApprovedTools } from "../src/tools/approved.ts";
import { TestEnv, testAgent } from "./support/test-env.ts";
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

testAgent()("shell skills", (it) => {
  it.effect("an approved script runs with its arguments; an edited one is refused", () =>
    Effect.gen(function* () {
      const { project } = yield* TestEnv;
      const [save, run] = yield* inRun((yield* ApprovedTools).forProject(project, "gate"));
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

      const [, runFull] = yield* inRun(
        (yield* ApprovedTools).forProject({ ...project, permissionMode: "full" }, "gate"),
      );
      expect(yield* sdk(() => runFull.execute!({ name: "echo-args" }))).toMatchObject({
        stdout: "changed",
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
                // Loopback skips the proxy unless told otherwise; through it, it stands in for a host.
                script: `curl -fsS --max-time 5 ${proxied ? "--noproxy ''" : ""} "http://127.0.0.1:$1/"`,
                network,
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
            script: 'echo x > .agents/skills/echo-args/SKILL.md; wc -c < "$1"',
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
