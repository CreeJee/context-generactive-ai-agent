import { Array as Arr, Effect, FileSystem, Option } from "effect";
import { expect, test } from "vite-plus/test";
import type { RunScope } from "../src/loop/run.ts";
import { listedCoverage, maxProjectCommands, ProjectCommands } from "../src/projects/commands.ts";
import { Projects } from "../src/projects/projects.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { ApprovedTools } from "../src/tools/approved.ts";
import { callTool, failureCode } from "./support/run-tools.ts";
import { TestEnv, testAgent } from "./support/test-env.ts";

const scope: RunScope = {
  threadId: "thread",
  runId: "run",
  emit: () => Effect.void,
  inBackground: Effect.ignore,
};

test("a script counts as listed only when every step starts with a listed command", () => {
  const commands = [
    { command: "vp test", purpose: "tests" },
    { command: "cd packages/api && cargo test", purpose: "API tests" },
  ];
  const covered = (script: string) => Option.isSome(listedCoverage(script, commands));
  expect(covered('vp test run "$@"')).toBe(true);
  expect(covered("set -e\ncd packages/api\ncargo test -- --nocapture 2>&1 | tail -40")).toBe(true);
  expect(covered("CI=1 vp test && cargo test")).toBe(true);
  // Another program that only starts with the same letters, and a step the list does not hold.
  expect(covered("vp testing")).toBe(false);
  expect(covered("vp test && node scripts/report.ts")).toBe(false);
  expect(covered("cd packages/api")).toBe(false);
  expect(listedCoverage("vp test run", commands)).toEqual(
    Option.some(`Every step of the script is a command of the project's command list ("vp test").`),
  );
});

/** A project of its own, so the command list a test reads is the one it wrote. */
const freshProject = Effect.gen(function* () {
  const { base } = yield* TestEnv;
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectory({ directory: base, prefix: "commands-" });
  return yield* (yield* Projects).add(root);
});

testAgent()("project commands", (it) => {
  it.effect("a list is kept per project in the order saved, and a change replaces or removes", () =>
    Effect.gen(function* () {
      const project = yield* freshProject;
      const commands = yield* ProjectCommands;
      expect(yield* commands.list(project.id)).toEqual([]);
      yield* commands.change(project.id, {
        commands: [
          { command: "vp check", purpose: "format, lint and type check" },
          { command: "vp test", purpose: "tests" },
        ],
      });
      expect(
        yield* commands.change(project.id, {
          commands: [{ command: "vp check", purpose: "every check before a commit" }],
          remove: ["vp test", "vp build"],
        }),
      ).toEqual({
        commands: [{ command: "vp check", purpose: "every check before a commit" }],
        notListed: ["vp build"],
      });
    }),
  );

  it.effect("a list that would be too long is refused and stays as it was", () =>
    Effect.gen(function* () {
      const project = yield* freshProject;
      const commands = yield* ProjectCommands;
      const tool = [commands.toolFor(project.id)];
      const numbered = (count: number, from = 0) =>
        Arr.makeBy(count, (index) => ({
          command: `vp run task-${from + index}`,
          purpose: `task ${from + index}`,
        }));
      yield* callTool(tool, "save_project_commands", { commands: numbered(maxProjectCommands) });
      expect(
        yield* failureCode(
          callTool(tool, "save_project_commands", {
            commands: numbered(1, maxProjectCommands),
          }),
        ),
      ).toBe("too_many_commands");
      expect(yield* commands.list(project.id)).toHaveLength(maxProjectCommands);
      // Taking one off in the same call makes room.
      expect(
        yield* callTool(tool, "save_project_commands", {
          commands: numbered(1, maxProjectCommands),
          remove: ["vp run task-0"],
        }),
      ).toMatchObject({ commands: expect.objectContaining({ length: maxProjectCommands }) });
    }),
  );

  it.effect("a command of more than one line is not taken", () =>
    Effect.gen(function* () {
      const project = yield* freshProject;
      const tool = [(yield* ProjectCommands).toolFor(project.id)];
      expect(
        yield* Effect.exit(
          callTool(tool, "save_project_commands", {
            commands: [{ command: "vp check\nrm -rf build", purpose: "checks" }],
          }),
        ),
      ).toMatchObject({ _tag: "Failure" });
    }),
  );

  it.effect("a run starts with the list it found, and a project without one gets no prompt", () =>
    Effect.gen(function* () {
      const project = yield* freshProject;
      const commands = yield* ProjectCommands;
      const system = (hook: Effect.Success<ReturnType<typeof commands.hookFor>>) =>
        Effect.map(
          hook.request!(scope, { system: ["BASE"], history: [], tools: [] }),
          (request) => request.system,
        );
      const empty = yield* commands.hookFor(project.id);
      expect(yield* system(empty)).toEqual(["BASE"]);
      yield* commands.change(project.id, {
        commands: [{ command: "vp check", purpose: "format, lint and type check" }],
      });
      const listed = yield* commands.hookFor(project.id);
      const [base, added] = yield* system(listed);
      expect(base).toBe("BASE");
      expect(added).toMatch(/^\[Project commands\]\n/);
      expect(added).toContain('- "vp check": format, lint and type check');
      // What the run saves shows in the next run: this run's prompt stays as it started.
      yield* commands.change(project.id, { commands: [{ command: "vp test", purpose: "tests" }] });
      expect(yield* system(listed)).toEqual([base, added]);
      expect(yield* system(empty)).toEqual(["BASE"]);
    }),
  );

  it.effect(
    "a sh skill that only runs listed commands is refused, except where each command call asks",
    () =>
      Effect.gen(function* () {
        const project = yield* freshProject;
        const session = yield* (yield* Sessions).create(project.id);
        const approved = yield* ApprovedTools;
        yield* (yield* ProjectCommands).change(project.id, {
          commands: [{ command: "vp test", purpose: "tests" }],
        });
        const wrapper = {
          name: "run-tests",
          description: "Run the tests",
          program: { runtime: "sh", script: 'vp test run "$@"' },
        };
        const reviewed = approved.toolsFor(
          { ...project, permissionMode: "auto" },
          session.id,
          "gate",
        );
        expect(yield* Effect.flip(callTool(reviewed, "save_code_skill", wrapper))).toMatchObject({
          message: expect.stringContaining("project_command"),
        });
        // A script that does more than the listed command is a skill of its own.
        expect(
          yield* callTool(reviewed, "save_code_skill", {
            ...wrapper,
            program: { runtime: "sh", script: 'vp test run "$@"\nnode scripts/report.ts' },
          }),
        ).toMatchObject({ name: "run-tests" });
        // In `ask` mode a sh skill is how a command is approved once.
        const asking = approved.toolsFor({ ...project, permissionMode: "ask" }, session.id, "gate");
        expect(
          yield* callTool(asking, "save_code_skill", { ...wrapper, name: "run-tests-once" }),
        ).toMatchObject({ name: "run-tests-once" });
      }),
  );
});
