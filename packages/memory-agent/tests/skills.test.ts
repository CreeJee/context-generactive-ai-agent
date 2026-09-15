import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { CodexAppServer } from "../src/codex/app-server.ts";
import { CodexModels } from "../src/codex/models.ts";
import { Skills, parseFrontMatter } from "../src/skills/skills.ts";
import { SkillTools } from "../src/tools/skills.ts";
import { testRuntime } from "./support/runtime.ts";

const fakeServer = fileURLToPath(new URL("./support/fake-codex.mjs", import.meta.url));
const fakeCodex = CodexAppServer.withCommand({
  executable: process.execPath,
  args: [fakeServer, "--signed-in"],
});

function writeSkill(root: string, folder: string, frontMatter: string, body = "Do it well.") {
  const directory = join(root, folder);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), `---\n${frontMatter}\n---\n${body}`);
  return directory;
}

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
    expect(parseFrontMatter("no front matter").fields.size).toBe(0);
  });
});

describe("Skills", () => {
  test("lists global and project skills; a project skill replaces a global one of the same name", async () => {
    const { runtime, project, home, base } = await testRuntime();
    const global = join(home, ".agents", "skills");
    const local = join(project.root, ".agents", "skills");
    writeSkill(global, "review", "name: review\ndescription: Global review.");
    writeSkill(global, "deploy", "description: Deploy the app.");
    writeSkill(global, "broken", "name: broken");
    writeSkill(local, "review", "name: review\ndescription: Project review.", "Project rules.");
    writeFileSync(join(local, "review", "checklist.md"), "- [ ] tests");
    // A linked folder could point anywhere, so it is not a skill.
    const outside = writeSkill(join(base, "elsewhere"), "linked", "description: Linked.");
    symlinkSync(outside, join(global, "linked"));

    const skills = await runtime.runPromise(Skills);
    const catalog = skills.catalog(project);
    expect(catalog.skills.map((skill) => [skill.name, skill.scope, skill.description])).toEqual([
      ["deploy", "global", "Deploy the app."],
      ["review", "project", "Project review."],
    ]);
    expect(catalog.problems).toEqual([
      { scope: "global", directory: join(global, "broken"), problem: "no_description" },
    ]);

    const tools = await runtime.runPromise(Effect.map(SkillTools, (t) => t.forProject(project)));
    expect(tools.instructions).toContain("- review (project): Project review.");
    expect(tools.instructions).toContain("guidance, not permission");
    const read = tools.tools[0]?.execute;
    expect(await read?.({ name: "review" })).toMatchObject({
      scope: "project",
      directory: join(local, "review"),
      files: ["checklist.md"],
      instructions: "Project rules.",
    });
    expect(await read?.({ name: "linked" })).toEqual({ error: "skill_not_found", name: "linked" });
  });

  test("a chat run lists skills and offers read_skill only when there are skills", async () => {
    const { runtime, project, session } = await testRuntime({ codex: fakeCodex });
    await runtime.runPromise(Effect.flatMap(CodexModels, (models) => models.select("fast-1")));
    const Starts = Schema.Struct({
      log: Schema.Array(
        Schema.Struct({
          method: Schema.String,
          params: Schema.optional(
            Schema.Struct({
              baseInstructions: Schema.optional(Schema.String),
              dynamicTools: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
            }),
          ),
        }),
      ),
    });
    const send = async (text: string) => {
      const response = await runtime.runPromise(
        Effect.flatMap(AgentChat, (agent) =>
          agent.handle(
            new Request("http://127.0.0.1/api/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                threadId: session.id,
                runId: `run-${Math.random().toString(36).slice(2)}`,
                messages: [{ id: "m1", role: "user", content: text }],
                tools: [],
                context: [],
              }),
            }),
            session.id,
          ),
        ),
      );
      const events = await response.text();
      const log = await runtime.runPromise(
        Effect.flatMap(CodexAppServer, (codex) => codex.request("test/log", {}, Starts)),
      );
      return {
        events,
        start: log.log.filter((entry) => entry.method === "thread/start").at(-1)?.params,
      };
    };

    const without = await send("hello");
    expect(without.start?.dynamicTools?.map((tool) => tool.name)).not.toContain("read_skill");

    writeSkill(
      join(project.root, ".agents", "skills"),
      "greet",
      "name: greet\ndescription: Greet warmly.",
      "Say hello in Korean.",
    );
    const withSkill = await send('call read_skill {"name":"greet"}');
    expect(withSkill.start?.dynamicTools?.map((tool) => tool.name)).toContain("read_skill");
    expect(withSkill.start?.baseInstructions).toContain("- greet (project): Greet warmly.");
    expect(withSkill.events).toContain("Say hello in Korean.");
  });
});
