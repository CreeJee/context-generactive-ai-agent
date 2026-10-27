import { Effect, FileSystem, Path } from "effect";
import { expect } from "vite-plus/test";
import { FileReadPlatform } from "../../src/files/text.ts";
import { Projects } from "../../src/projects/projects.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import {
  Skills,
  builtinSkillsDirectory,
  maxDescriptionCharacters,
} from "../../src/skills/skills.ts";
import { SkillTools } from "../../src/tools/skills.ts";
import { Workflows } from "../../src/workflow/workflow.ts";
import { runTurn, toolResults } from "../support/chat-client.ts";
import { selectTestModel } from "../support/provider.ts";
import { callTool } from "../support/run-tools.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";

const writeSkill = Effect.fnUntraced(function* (
  root: string,
  folder: string,
  frontMatter: string,
  body: string = "Do it well.",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(root, folder);
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.writeFileString(path.join(directory, "SKILL.md"), `---\n${frontMatter}\n---\n${body}`);
  return directory;
});

/** Project skills belong to the project, so tests sharing an agent each register their own. */
const freshProject = Effect.gen(function* () {
  const env = yield* TestEnv;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const project = yield* (yield* Projects).add(
    yield* fs.makeTempDirectory({ directory: env.base }),
  );
  return { project, skills: path.join(project.root, ".agents", "skills") };
});

const globalSkills = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.join((yield* TestEnv).home, ".agents", "skills");
});

const platforms =
  process.platform === "win32" ? (["windows"] as const) : (["posix", "windows"] as const);

testAgent()("linked skill files", (it) => {
  it.effect.each(platforms)(
    "%s: rejects linked skill files while preserving ordinary hard-linked files",
    (platform) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { project, skills: root } = yield* freshProject;
        const outside = yield* writeSkill(project.root, "outside", "description: Shared rules.");
        const source = path.join(outside, "SKILL.md");
        for (const name of ["symbolic", "hard"]) {
          yield* fs.makeDirectory(path.join(root, name), { recursive: true });
        }
        yield* fs.symlink(source, path.join(root, "symbolic", "SKILL.md"));
        yield* fs.link(source, path.join(root, "hard", "SKILL.md"));
        const skills = yield* Skills;
        expect((yield* skills.catalog(project)).skills.map((skill) => skill.name)).toEqual([
          "hard",
        ]);
        expect(yield* skills.read(project, "symbolic")).toBeNull();
        expect(yield* skills.read(project, "hard")).toMatchObject({ body: "Do it well." });
      }).pipe(Effect.provideService(FileReadPlatform, platform)),
  );
});

// Global and built-in skills are shared by every project, so each catalog owns an agent.
testAgent()("global and project skills", (it) => {
  it.effect(
    "lists global and project skills; a project skill replaces a global one of the same name",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { project, base } = yield* TestEnv;
        const global = yield* globalSkills;
        const local = path.join(project.root, ".agents", "skills");
        yield* writeSkill(global, "review", "name: review\ndescription: Global review.");
        yield* writeSkill(global, "deploy", "description: Deploy the app.");
        yield* writeSkill(global, "broken", "name: broken");
        yield* writeSkill(
          local,
          "review",
          "name: review\ndescription: Project review.",
          "Project rules.",
        );
        yield* fs.writeFileString(path.join(local, "review", "checklist.md"), "- [ ] tests");
        // A linked folder could point anywhere, so it is not a skill.
        const outside = yield* writeSkill(
          path.join(base, "elsewhere"),
          "linked",
          "description: Linked.",
        );
        yield* fs.symlink(outside, path.join(global, "linked"));
        const catalog = yield* (yield* Skills).catalog(project);
        expect(catalog.skills.map((skill) => [skill.name, skill.scope, skill.description])).toEqual(
          [
            ["deploy", "global", "Deploy the app."],
            ["review", "project", "Project review."],
          ],
        );
        expect(catalog.problems).toEqual([
          { scope: "global", directory: path.join(global, "broken"), problem: "no_description" },
        ]);
        const tools = yield* (yield* SkillTools).runToolsFor(project);
        expect(tools.instructions).toContain("- review (project): Project review.");
        // How to treat a skill comes with the skill read, not with the list.
        expect(yield* callTool(tools.tools, "read_skill", { name: "review" })).toMatchObject({
          scope: "project",
          directory: path.join(local, "review"),
          files: ["checklist.md"],
          instructions: "Project rules.",
          note: expect.stringMatching(/guidance, not permission.*with read_file\.$/),
        });
        expect(yield* callTool(tools.tools, "read_skill", { name: "linked" })).toEqual({
          error: "skill_not_found",
          name: "linked",
        });
      }),
  );
});

testAgent()("built-in skills", (it) => {
  it.effect(
    "built-in skills are listed, and the user's or the project's replace them by name",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { project, base } = yield* TestEnv;
        // The block's built-in directory; the agent reads it on every catalog.
        const builtin = path.join(base, "builtin-skills");
        yield* writeSkill(builtin, "draw", "name: draw\ndescription: App drawing.", "App rules.");
        yield* writeSkill(builtin, "tidy", "name: tidy\ndescription: App tidying.", "Tidy rules.");
        yield* fs.writeFileString(path.join(builtin, "tidy", "notes.md"), "not for the model");
        yield* writeSkill(yield* globalSkills, "draw", "name: draw\ndescription: My drawing.");
        const skills = yield* Skills;
        expect(
          (yield* skills.catalog(project)).skills.map((skill) => [
            skill.name,
            skill.scope,
            skill.description,
          ]),
        ).toEqual([
          ["draw", "global", "My drawing."],
          ["tidy", "builtin", "App tidying."],
        ]);
        // The executable unpacks built-in skills under the storage root, which the file tools refuse,
        // so a built-in skill never points the model at files beside it.
        expect(yield* skills.read(project, "tidy")).toMatchObject({
          scope: "builtin",
          files: [],
          body: "Tidy rules.",
        });
      }),
  );
});

testAgent({ skillsBuiltin: await Effect.runPromise(builtinSkillsDirectory) })(
  "the skills this app ships",
  (it) => {
    it.effect("are readable and within limits", () =>
      Effect.gen(function* () {
        const catalog = yield* (yield* Skills).catalog((yield* TestEnv).project);
        expect(catalog.problems).toEqual([]);
        const shipped = catalog.skills.filter((skill) => skill.scope === "builtin");
        expect(shipped.map((skill) => skill.name)).toContain("draw");
        for (const skill of shipped) {
          expect(skill.description.length).toBeGreaterThan(0);
          expect(skill.description.length).toBeLessThanOrEqual(maxDescriptionCharacters);
        }
      }),
    );
  },
);

/** Sends one user turn: its run's tool results, and the model's first invocation in it. */
const send = Effect.fnUntraced(function* (session: string, runId: string, text: string) {
  const { provider } = yield* TestEnv;
  const invocationIndex = provider?.invocations.length ?? 0;
  const events = yield* runTurn(session, runId, text);
  return {
    results: toolResults(events),
    invocation: provider?.invocations[invocationIndex],
  };
});

testAgent({ testProvider: {} })("skills in a run", (it) => {
  it.effect.each(["chat", "goal"] as const)(
    "a %s run lists skills and offers read_skill only when there are skills",
    (phase) =>
      Effect.gen(function* () {
        const { project, skills } = yield* freshProject;
        const session = (yield* (yield* Sessions).create(project.id)).id;
        yield* selectTestModel();
        switch (phase) {
          case "chat":
            break;
          case "goal": {
            const workflows = yield* Workflows;
            yield* workflows.updateGoal(session, {
              statement: "Greet the user using the available skill",
              outcomes: ["Say hello in Korean"],
              constraints: [],
              nonGoals: [],
              assumptions: [],
              openQuestions: [],
              status: "active",
            });
            yield* workflows.setPhase(session, "goal");
            break;
          }
        }
        const without = yield* send(session, `${session}:without`, "hello");
        expect(without.invocation?.toolNames).not.toContain("read_skill");
        yield* writeSkill(
          skills,
          "greet",
          "name: greet\ndescription: Greet warmly.",
          "Say hello in Korean.",
        );
        const withSkill = yield* send(
          session,
          `${session}:with`,
          'call read_skill {"name":"greet"}',
        );
        expect(withSkill.invocation?.toolNames).toContain("read_skill");
        expect(withSkill.invocation?.system.join("\n")).toContain(
          "- greet (project): Greet warmly.",
        );
        expect(withSkill.results.join("\n")).toContain("Say hello in Korean.");
      }),
  );
});
