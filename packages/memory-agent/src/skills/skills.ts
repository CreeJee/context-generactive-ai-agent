import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { Hex } from "effect/encoding";
import { readFileBytesEffect } from "../files/text.ts";
import {
  Context as PlatformContext,
  Effect as PlatformEffect,
  Layer as PlatformLayer,
  Path,
} from "effect";
import { isTruthy } from "../truthy.ts";
import * as NodePath from "@effect/platform-node/NodePath";
import { MutableHashMap, Option, Context, Effect, FileSystem, Crypto, Layer, Schema } from "effect";
import type { Project } from "../projects/projects.ts";
import { homeDirectory } from "../runtime/host-system.ts";
import { runtimeRequire, runtimeRoot } from "../runtime/resources.ts";

// Path operations remain synchronous at these public host boundaries.
const { dirname, join } = PlatformEffect.runSync(
  PlatformEffect.scoped(
    PlatformEffect.gen(function* () {
      const services = yield* PlatformLayer.build(NodePath.layer);
      return PlatformContext.get(services, Path.Path);
    }),
  ),
);

/**
 * Where a skill comes from. `builtin` ships with this app; the user's own (`global`) and the
 * project's replace a built-in skill of the same name, so any of them can be overridden.
 */
export const SkillScope = Schema.Literals(["builtin", "global", "project"]);
export type SkillScope = typeof SkillScope.Type;

/**
 * The skills this app ships: `skills/` in this package, which the executable unpacks next to its
 * other runtime files. Resolved from the package rather than this module, because the app bundles
 * this module into its server build.
 */
export function builtinSkillsDirectory() {
  const root = runtimeRoot();
  if (root !== null) return join(root, "skills");
  return join(dirname(runtimeRequire().resolve("memory-agent/package.json")), "skills");
}

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
  /** SHA-256 of the exact SKILL.md used to discover this skill. */
  readonly contentHash: string;
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
  readonly fields: MutableHashMap.MutableHashMap<string, string>;
  readonly body: string;
}

/**
 * The front matter keys a skill needs, from the small YAML subset SKILL.md files use: `key: value`
 * (optionally quoted) and folded or literal blocks (`key: >` / `key: |` with indented lines).
 */
export function parseFrontMatter(text: string): FrontMatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!isTruthy(match)) return { fields: MutableHashMap.empty(), body: text };
  const fields = MutableHashMap.empty<string, string>();
  const lines = (match[1] ?? "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!isTruthy(field)) continue;
    const key = field[1] ?? "";
    const value = (field[2] ?? "").trim();
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const block: string[] = [];
      while (index + 1 < lines.length && /^(\s+|$)/.test(lines[index + 1] ?? "")) {
        index++;
        block.push((lines[index] ?? "").trim());
      }
      MutableHashMap.set(
        fields,
        key,
        value.startsWith(">") ? block.join(" ").trim() : block.join("\n").trim(),
      );
      continue;
    }
    MutableHashMap.set(fields, key, value.replace(/^(["'])(.*)\1$/, "$2"));
  }
  return { fields, body: text.slice(match[0].length) };
}

const skillFileOf = (directory: string) => join(directory, "SKILL.md");

type SkillRead =
  | { readonly _tag: "none" }
  | { readonly _tag: "skill"; readonly skill: Skill; readonly body: string }
  | { readonly _tag: "problem"; readonly problem: SkillProblem };

export interface SkillsOptions {
  /** Where global skills live; tests use a temporary home. */
  readonly home?: string;
  /** Where the app's own skills live; tests point it elsewhere to control what is listed. */
  readonly builtin?: string;
}

const make = (options: SkillsOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const crypto = yield* Crypto.Crypto;
    const home = options.home ?? (yield* homeDirectory);
    const builtinRoot = options.builtin ?? builtinSkillsDirectory();

    const readSkill = Effect.fn("Skills.readSkill")(function* (
      scope: SkillScope,
      directory: string,
      folder: string,
    ): Effect.fn.Return<SkillRead> {
      const file = skillFileOf(directory);
      const problem = (kind: SkillProblem["problem"]): SkillRead => ({
        _tag: "problem",
        problem: { scope, directory, problem: kind },
      });
      return yield* Effect.gen(function* (): Effect.fn.Return<
        SkillRead,
        | import("../files/text.ts").TextFileIoFailed
        | import("../files/text.ts").TextFileRejected
        | import("../files/paths.ts").PathRejected
        | import("effect/PlatformError").PlatformError
      > {
        if (!(yield* fs.exists(file))) return { _tag: "none" };
        const entry = yield* fs.lstat(file);
        if (entry.type !== "File") return { _tag: "none" };
        if (Number(entry.size) > maxSkillBytes) return problem("too_large");
        // Open the same leaf without following a link swapped in after discovery.
        const { bytes } = yield* readFileBytesEffect({ absolute: file, path: file });
        if (bytes.length > maxSkillBytes) return problem("too_large");
        const text = new TextDecoder().decode(bytes);
        const { fields, body } = parseFrontMatter(text);
        const description = Option.getOrUndefined(MutableHashMap.get(fields, "description")) ?? "";
        if (description.length === 0) return problem("no_description");
        return {
          _tag: "skill",
          body,
          skill: {
            scope,
            name: Option.getOrUndefined(MutableHashMap.get(fields, "name")) || folder,
            description: description.slice(0, maxDescriptionCharacters),
            directory,
            contentHash: Hex.encode(
              yield* crypto.digest("SHA-256", new TextEncoder().encode(text)),
            ),
          },
        };
      }).pipe(
        // A skill that cannot be read is listed as a problem, not dropped silently.
        Effect.catchTags({
          PlatformError: () => Effect.succeed(problem("unreadable")),
          PathRejected: () => Effect.succeed(problem("unreadable")),
          TextFileIoFailed: () => Effect.succeed(problem("unreadable")),
          TextFileRejected: () => Effect.succeed(problem("unreadable")),
        }),
      );
    });

    const scan = Effect.fn("Skills.scan")(function* (scope: SkillScope, root: string) {
      const skills: Array<{ skill: Skill; body: string }> = [];
      const problems: SkillProblem[] = [];
      if (!(yield* fs.exists(root))) return { skills, problems };
      if ((yield* fs.stat(root)).type !== "Directory") return { skills, problems };
      for (const folder of (yield* fs.readDirectory(root)).sort()) {
        if (folder.startsWith(".")) continue;
        const directory = join(root, folder);
        const plain = yield* fs.lstat(directory).pipe(
          Effect.map((entry) => entry.type === "Directory"),
          Effect.catchTag("PlatformError", () => Effect.succeed(false)),
        );
        if (!plain) continue;
        const read = yield* readSkill(scope, directory, folder);
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
    });
    const filesOf = Effect.fn("Skills.filesOf")(function* (skill: Skill) {
      switch (skill.scope) {
        case "builtin":
          return [];
        case "global":
        case "project":
          return (yield* fs.readDirectory(skill.directory))
            .filter((file) => file !== "SKILL.md" && !file.startsWith("."))
            .sort()
            .slice(0, 100);
      }
    });
    const load = Effect.fn("Skills.load")(function* (project: Project) {
      // Later scopes win on a shared name: the app's defaults, then the user's, then the project's.
      const layers = [
        yield* scan("builtin", builtinRoot),
        yield* scan("global", globalSkillsDirectory(home)),
        yield* scan("project", projectSkillsDirectory(project.root)),
      ];
      const byName = MutableHashMap.empty<string, { skill: Skill; body: string }>();
      for (const layer of layers)
        for (const entry of layer.skills) MutableHashMap.set(byName, entry.skill.name, entry);
      return {
        entries: [...MutableHashMap.values(byName)],
        problems: layers.flatMap((layer) => layer.problems),
      };
    });

    return {
      globalDirectory: globalSkillsDirectory(home),
      catalog: Effect.fn("Skills.catalog")(function* (
        project: Project,
      ): Effect.fn.Return<SkillCatalog, import("effect/PlatformError").PlatformError> {
        const { entries, problems } = yield* load(project);
        return {
          directories: [
            { scope: "global", path: globalSkillsDirectory(home) },
            { scope: "project", path: projectSkillsDirectory(project.root) },
          ],
          skills: entries.map((entry) => entry.skill),
          problems,
        };
      }),
      read: Effect.fn("Skills.read")(function* (
        project: Project,
        name: string,
      ): Effect.fn.Return<SkillDocument | null, import("effect/PlatformError").PlatformError> {
        const entry = (yield* load(project)).entries.find(
          (candidate) => candidate.skill.name === name,
        );
        if (entry === undefined) return null;
        return { ...entry.skill, body: entry.body, files: yield* filesOf(entry.skill) };
      }),
    };
  });

/** Agent skills (SKILL.md folders) from the user's shared directory and the project (R18). */
export class Skills extends Context.Service<Skills, Effect.Success<ReturnType<typeof make>>>()(
  "memory-agent/skills/skills",
) {
  static readonly layer = (options: SkillsOptions = {}) =>
    Layer.effect(Skills, make(options)).pipe(
      Layer.provide(Layer.merge(NodeFileSystem.layer, NodeCrypto.layer)),
    );
}
