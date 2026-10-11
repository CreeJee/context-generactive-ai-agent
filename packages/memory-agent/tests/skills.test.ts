import { Cause, MutableHashMap, Random, Effect, FileSystem, Path, Schema } from "effect";
import { it } from "@effect/vitest";
import { describe, expect, test } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import {
  Skills,
  builtinSkillsDirectory,
  maxDescriptionCharacters,
  parseFrontMatter,
} from "../src/skills/skills.ts";
import { SkillTools } from "../src/tools/skills.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { testRuntime } from "./support/runtime.ts";
import { selectTestModel } from "./support/provider.ts";
import { withTestPlatform } from "./support/platform.ts";
import { FileReadPlatform } from "../src/files/text.ts";

const writeSkill = Effect.fn("writeSkill")(function* (
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
const call = Effect.fn("skillSdkCall")(<A>(operation: () => A | PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);

describe("parseFrontMatter", () => {
  test("reads plain, quoted and folded values and returns the body", () => {
    const { fields, body } = parseFrontMatter(
      '---\nname: "review"\ndescription: >\n  Review a change\n  line by line.\nnotes: |\n  a\n  b\nlicense: MIT\n---\n# Body\n',
    );
    expect(Object.fromEntries(fields)).toEqual({
      name: "review",
      description: "Review a change line by line.",
      notes: "a\nb",
      license: "MIT",
    });
    expect(body).toBe("# Body\n");
    expect(MutableHashMap.size(parseFrontMatter("no front matter").fields)).toBe(0);
  });
});

describe("Skills", () => {
  const platforms =
    process.platform === "win32" ? (["windows"] as const) : (["posix", "windows"] as const);
  for (const platform of platforms) {
    it.live(
      `${platform}: rejects linked skill files while preserving ordinary hard-linked files`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { runtime, project, home, base } = yield* call(() => testRuntime());
          const root = path.join(home, ".agents", "skills");
          const outside = yield* writeSkill(base, "outside", "description: Shared rules.");
          const source = path.join(outside, "SKILL.md");
          for (const name of ["symbolic", "hard"]) {
            yield* fs.makeDirectory(path.join(root, name), { recursive: true });
          }
          yield* fs.symlink(source, path.join(root, "symbolic", "SKILL.md"));
          yield* fs.link(source, path.join(root, "hard", "SKILL.md"));
          const skills = yield* Effect.provideContext(Skills, yield* runtime.contextEffect);
          expect((yield* skills.catalog(project)).skills.map((skill) => skill.name)).toEqual([
            "hard",
          ]);
          expect(yield* skills.read(project, "symbolic")).toBeNull();
          expect(yield* skills.read(project, "hard")).toMatchObject({ body: "Do it well." });
        }).pipe(Effect.provideService(FileReadPlatform, platform), withTestPlatform),
    );
  }

  it.live(
    "lists global and project skills; a project skill replaces a global one of the same name",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { runtime, project, home, base } = yield* call(() => testRuntime());
        const global = path.join(home, ".agents", "skills");
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
        const skills = yield* Effect.provideContext(Skills, yield* runtime.contextEffect);
        const catalog = yield* skills.catalog(project);
        expect(catalog.skills.map((skill) => [skill.name, skill.scope, skill.description])).toEqual(
          [
            ["deploy", "global", "Deploy the app."],
            ["review", "project", "Project review."],
          ],
        );
        expect(catalog.problems).toEqual([
          { scope: "global", directory: path.join(global, "broken"), problem: "no_description" },
        ]);
        const tools = yield* Effect.provideContext(
          Effect.flatMap(SkillTools, (t) => t.forProject(project)),
          yield* runtime.contextEffect,
        );
        expect(tools.instructions).toContain("- review (project): Project review.");
        expect(tools.instructions).toContain("guidance, not permission");
        const read = tools.tools[0]?.execute;
        expect(yield* call(() => read?.({ name: "review" }))).toMatchObject({
          scope: "project",
          directory: path.join(local, "review"),
          files: ["checklist.md"],
          instructions: "Project rules.",
        });
        expect(yield* call(() => read?.({ name: "linked" }))).toEqual({
          error: "skill_not_found",
          name: "linked",
        });
      }).pipe(withTestPlatform),
  );

  it.live("built-in skills are listed, and the user's or the project's replace them by name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { base, home } = yield* call(() => testRuntime());
      const builtin = path.join(base, "builtin");
      yield* writeSkill(builtin, "draw", "name: draw\ndescription: App drawing.", "App rules.");
      yield* writeSkill(builtin, "tidy", "name: tidy\ndescription: App tidying.", "Tidy rules.");
      yield* fs.writeFileString(path.join(builtin, "tidy", "notes.md"), "not for the model");
      yield* writeSkill(
        path.join(home, ".agents", "skills"),
        "draw",
        "name: draw\ndescription: My drawing.",
      );
      const { runtime, project } = yield* call(() =>
        testRuntime({ skillsBuiltin: builtin, skillsHome: home }),
      );
      const skills = yield* Effect.provideContext(Skills, yield* runtime.contextEffect);
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
    }).pipe(withTestPlatform),
  );

  it.live("the skills this app ships are readable and within limits", () =>
    Effect.gen(function* () {
      const { runtime, project } = yield* call(() =>
        testRuntime({ skillsBuiltin: builtinSkillsDirectory() }),
      );
      const catalog = yield* (yield* Effect.provideContext(
        Skills,
        yield* runtime.contextEffect,
      )).catalog(project);
      expect(catalog.problems).toEqual([]);
      const shipped = catalog.skills.filter((skill) => skill.scope === "builtin");
      expect(shipped.map((skill) => skill.name)).toContain("draw");
      for (const skill of shipped) {
        expect(skill.description.length).toBeGreaterThan(0);
        expect(skill.description.length).toBeLessThanOrEqual(maxDescriptionCharacters);
      }
    }).pipe(withTestPlatform),
  );

  it.live.each(["chat", "goal"] as const)(
    "a %s run lists skills and offers read_skill only when there are skills",
    (phase) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const context = yield* call(() => testRuntime({ testProvider: {} }));
        const { runtime, project, session } = context;
        yield* selectTestModel().pipe(Effect.provideContext(yield* runtime.contextEffect));
        if (phase === "goal") {
          const workflows = yield* Effect.provideContext(Workflows, yield* runtime.contextEffect);
          yield* Effect.provideContext(
            workflows.updateGoal(session.id, {
              statement: "Greet the user using the available skill",
              outcomes: ["Say hello in Korean"],
              constraints: [],
              nonGoals: [],
              assumptions: [],
              openQuestions: [],
              status: "active",
            }),
            yield* runtime.contextEffect,
          );
          yield* Effect.provideContext(
            workflows.setPhase(session.id, "goal"),
            yield* runtime.contextEffect,
          );
        }
        const send = Effect.fn("skills.send")(function* (text: string) {
          const invocationIndex = context.provider!.adapter.invocations.length;
          const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            threadId: session.id,
            runId: `run-${(yield* Random.next).toString(36).slice(2)}`,
            messages: [{ id: "m1", role: "user", content: text }],
            tools: [],
            context: [],
          });
          const response = yield* Effect.provideContext(
            Effect.flatMap(AgentChat, (agent) =>
              agent.handle(
                new Request("http://127.0.0.1/api/chat", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body,
                }),
                session.id,
              ),
            ),
            yield* runtime.contextEffect,
          );
          const events = yield* call(() => response.text());
          return { events, invocation: context.provider!.adapter.invocations[invocationIndex] };
        });
        const without = yield* send("hello");
        expect(without.invocation?.toolNames).not.toContain("read_skill");
        yield* writeSkill(
          path.join(project.root, ".agents", "skills"),
          "greet",
          "name: greet\ndescription: Greet warmly.",
          "Say hello in Korean.",
        );
        const withSkill = yield* send('call read_skill {"name":"greet"}');
        expect(withSkill.invocation?.toolNames).toContain("read_skill");
        expect(withSkill.invocation?.systemPrompts.join("\n")).toContain(
          "- greet (project): Greet warmly.",
        );
        expect(withSkill.events).toContain("Say hello in Korean.");
      }).pipe(withTestPlatform),
  );
});
