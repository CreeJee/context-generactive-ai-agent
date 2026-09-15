import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import type { Project } from "../projects/projects.ts";

export const SkillScope = Schema.Literal("global", "project");
export type SkillScope = typeof SkillScope.Type;

/** Shared with other agents: `npx skills add -g` installs here. */
export const globalSkillsDirectory = (home: string) => join(home, ".agents", "skills");
/** A project's own skills, checked into the repository. */
export const projectSkillsDirectory = (projectRoot: string) =>
  join(projectRoot, ".agents", "skills");

/** Longest SKILL.md read, and longest description shown to the model. */
export const maxSkillBytes = 256 * 1024;
export const maxDescriptionCharacters = 1_024;
/** How many skills the instructions list at most. */
export const maxListedSkills = 100;

export interface Skill {
  readonly scope: SkillScope;
  readonly name: string;
  readonly description: string;
  readonly directory: string;
}

export interface SkillProblem {
  readonly scope: SkillScope;
  readonly directory: string;
  readonly problem: "no_description" | "too_large" | "unreadable";
}

export interface SkillCatalog {
  readonly directories: ReadonlyArray<{ scope: SkillScope; path: string }>;
  /** Project skills replace global ones with the same name. */
  readonly skills: readonly Skill[];
  readonly problems: readonly SkillProblem[];
}

export interface SkillDocument extends Skill {
  /** SKILL.md without its front matter. */
  readonly body: string;
  /** Other files in the skill directory (one level), which the skill may refer to. */
  readonly files: readonly string[];
}

export interface FrontMatter {
  readonly fields: ReadonlyMap<string, string>;
  readonly body: string;
}

/**
 * The front matter keys a skill needs, from the small YAML subset SKILL.md files use: `key: value`
 * (optionally quoted) and folded or literal blocks (`key: >` / `key: |` with indented lines).
 */
export function parseFrontMatter(text: string): FrontMatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { fields: new Map(), body: text };
  const fields = new Map<string, string>();
  const lines = (match[1] ?? "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!field) continue;
    const key = field[1] ?? "";
    const value = (field[2] ?? "").trim();
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const block: string[] = [];
      while (index + 1 < lines.length && /^(\s+|$)/.test(lines[index + 1] ?? "")) {
        index++;
        block.push((lines[index] ?? "").trim());
      }
      fields.set(key, value.startsWith(">") ? block.join(" ").trim() : block.join("\n").trim());
      continue;
    }
    fields.set(key, value.replace(/^(["'])(.*)\1$/, "$2"));
  }
  return { fields, body: text.slice(match[0].length) };
}

const skillFileOf = (directory: string) => join(directory, "SKILL.md");

/** Real directories only: a link could point a skill anywhere. */
const isPlainDirectory = (path: string) => {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
};

type SkillRead =
  | { readonly _tag: "none" }
  | { readonly _tag: "skill"; readonly skill: Skill; readonly body: string }
  | { readonly _tag: "problem"; readonly problem: SkillProblem };

function readSkill(scope: SkillScope, directory: string, folder: string): SkillRead {
  const file = skillFileOf(directory);
  const problem = (kind: SkillProblem["problem"]): SkillRead => ({
    _tag: "problem",
    problem: { scope, directory, problem: kind },
  });
  try {
    if (!existsSync(file)) return { _tag: "none" };
    const stats = lstatSync(file);
    if (!stats.isFile()) return { _tag: "none" };
    if (stats.size > maxSkillBytes) return problem("too_large");
    const { fields, body } = parseFrontMatter(readFileSync(file, "utf8"));
    const description = fields.get("description") ?? "";
    if (description.length === 0) return problem("no_description");
    const skill: Skill = {
      scope,
      name: fields.get("name") || folder,
      description: description.slice(0, maxDescriptionCharacters),
      directory,
    };
    return { _tag: "skill", skill, body };
  } catch {
    return problem("unreadable");
  }
}

function scan(scope: SkillScope, root: string) {
  const skills: Array<{ skill: Skill; body: string }> = [];
  const problems: SkillProblem[] = [];
  if (!existsSync(root) || !statSync(root).isDirectory()) return { skills, problems };
  for (const folder of readdirSync(root).sort()) {
    const directory = join(root, folder);
    if (folder.startsWith(".") || !isPlainDirectory(directory)) continue;
    const read = readSkill(scope, directory, folder);
    switch (read._tag) {
      case "none":
        break;
      case "skill":
        skills.push(read);
        break;
      case "problem":
        problems.push(read.problem);
        break;
    }
  }
  return { skills, problems };
}

export interface SkillsOptions {
  /** Where global skills live; tests use a temporary home. */
  readonly home?: string;
}

const make = (options: SkillsOptions) =>
  Effect.sync(() => {
    const home = options.home ?? homedir();

    const load = (project: Project) => {
      const global = scan("global", globalSkillsDirectory(home));
      const local = scan("project", projectSkillsDirectory(project.root));
      const localNames = new Set(local.skills.map((entry) => entry.skill.name));
      return {
        entries: [
          ...global.skills.filter((entry) => !localNames.has(entry.skill.name)),
          ...local.skills,
        ],
        problems: [...global.problems, ...local.problems],
      };
    };

    return {
      catalog: (project: Project): SkillCatalog => {
        const { entries, problems } = load(project);
        return {
          directories: [
            { scope: "global", path: globalSkillsDirectory(home) },
            { scope: "project", path: projectSkillsDirectory(project.root) },
          ],
          skills: entries.map((entry) => entry.skill),
          problems,
        };
      },

      read: (project: Project, name: string): SkillDocument | null => {
        const entry = load(project).entries.find((candidate) => candidate.skill.name === name);
        if (!entry) return null;
        const files = readdirSync(entry.skill.directory)
          .filter((file) => file !== "SKILL.md" && !file.startsWith("."))
          .sort()
          .slice(0, 100);
        return { ...entry.skill, body: entry.body, files };
      },
    };
  });

/** Agent skills (SKILL.md folders) from the user's shared directory and the project (R18). */
export class Skills extends Context.Tag("memory-agent/Skills")<
  Skills,
  Effect.Effect.Success<ReturnType<typeof make>>
>() {
  static readonly layer = (options: SkillsOptions = {}) => Layer.effect(Skills, make(options));
}
