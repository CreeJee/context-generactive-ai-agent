import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { Hex } from "effect/encoding";
import { readFileBytesEffect } from "../files/text.ts";
import { isTruthy } from "../truthy.ts";
import { path } from "../runtime/synchronous-path.ts";
import {
  Array as EffectArray,
  Match,
  MutableHashMap,
  Option,
  Context,
  Data,
  Effect,
  FileSystem,
  Crypto,
  Layer,
  Schema,
} from "effect";
import type { Project } from "../projects/projects.ts";
import { homeDirectory } from "../runtime/host-system.ts";
import { runtimeRequire, runtimeRoot } from "../runtime/resources.ts";

// Path operations remain synchronous at these public host boundaries.
const { dirname, join } = path;

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
export const builtinSkillsDirectory = Effect.gen(function* () {
  const root = Option.fromNullishOr(yield* runtimeRoot);
  const packageRoot = yield* Option.match(root, {
    onSome: Effect.succeed,
    onNone: () =>
      Effect.map(runtimeRequire, (packageRequire) =>
        dirname(packageRequire.resolve("memory-agent/package.json")),
      ),
  });
  return join(packageRoot, "skills");
});

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

/** `key: >` folds the indented lines after it into one line; `key: |` keeps them as lines. */
const blockMarkers: readonly string[] = [">", "|", ">-", "|-"];
const blockValue = (following: readonly string[], marker: string) =>
  EffectArray.takeWhile(following, (line) => /^(\s+|$)/.test(line))
    .map((line) => line.trim())
    .join(marker.startsWith(">") ? " " : "\n")
    .trim();

/**
 * The front matter keys a skill needs, from the small YAML subset SKILL.md files use: `key: value`
 * (optionally quoted) and folded or literal blocks (`key: >` / `key: |` with indented lines).
 */
export function parseFrontMatter(text: string): FrontMatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!isTruthy(match)) return { fields: MutableHashMap.empty(), body: text };
  const lines = (match[1] ?? "").split(/\r?\n/);
  // A block's indented lines never read as a field of their own, so every line is tried as one.
  const fields = MutableHashMap.fromIterable(
    lines.flatMap((line, index) =>
      Option.toArray(Option.fromNullishOr(/^([A-Za-z][\w-]*):\s*(.*)$/.exec(line))).map(
        ([, key = "", raw = ""]) => {
          const value = raw.trim();
          return [
            key,
            blockMarkers.includes(value)
              ? blockValue(lines.slice(index + 1), value)
              : value.replace(/^(["'])(.*)\1$/, "$2"),
          ] as const;
        },
      ),
    ),
  );
  return { fields, body: text.slice(match[0].length) };
}

const skillFileOf = (directory: string) => join(directory, "SKILL.md");

type SkillRead = Data.TaggedEnum<{
  none: {};
  skill: { readonly skill: Skill; readonly body: string };
  problem: { readonly problem: SkillProblem };
}>;
const SkillRead = Data.taggedEnum<SkillRead>();

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
    const builtinRoot = options.builtin ?? (yield* builtinSkillsDirectory);

    const readSkill = Effect.fn("Skills.readSkill")(function* (
      scope: SkillScope,
      directory: string,
      folder: string,
    ): Effect.fn.Return<SkillRead> {
      const file = skillFileOf(directory);
      const problem = (kind: SkillProblem["problem"]): SkillRead =>
        SkillRead.problem({ problem: { scope, directory, problem: kind } });
      return yield* Effect.gen(function* (): Effect.fn.Return<
        SkillRead,
        | import("../files/text.ts").TextFileIoFailed
        | import("../files/text.ts").TextFileRejected
        | import("../files/paths.ts").PathRejected
        | import("effect/PlatformError").PlatformError
      > {
        if (!(yield* fs.exists(file))) return SkillRead.none();
        const entry = yield* fs.lstat(file);
        if (entry.type !== "File") return SkillRead.none();
        if (Number(entry.size) > maxSkillBytes) return problem("too_large");
        // Open the same leaf without following a link swapped in after discovery.
        const { bytes } = yield* readFileBytesEffect({ absolute: file, path: file });
        if (bytes.length > maxSkillBytes) return problem("too_large");
        const text = new TextDecoder().decode(bytes);
        const { fields, body } = parseFrontMatter(text);
        const description = Option.getOrUndefined(MutableHashMap.get(fields, "description")) ?? "";
        if (description.length === 0) return problem("no_description");
        return SkillRead.skill({
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
        });
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
      const folders =
        (yield* fs.exists(root)) && (yield* fs.stat(root)).type === "Directory"
          ? (yield* fs.readDirectory(root)).filter((folder) => !folder.startsWith(".")).sort()
          : [];
      const reads = yield* Effect.forEach(folders, (folder) => {
        const directory = join(root, folder);
        return Effect.when(
          readSkill(scope, directory, folder),
          fs.lstat(directory).pipe(
            Effect.map((entry) => entry.type === "Directory"),
            Effect.catchTag("PlatformError", () => Effect.succeed(false)),
          ),
        );
      });
      const found = EffectArray.getSomes(reads);
      return {
        skills: found.filter(SkillRead.$is("skill")),
        problems: found.filter(SkillRead.$is("problem")).map((read) => read.problem),
      };
    });
    const filesOf = Effect.fn("Skills.filesOf")(function* (skill: Skill) {
      return yield* Match.value(skill.scope).pipe(
        Match.when("builtin", () => Effect.succeed<readonly string[]>([])),
        Match.whenOr("global", "project", () =>
          Effect.map(fs.readDirectory(skill.directory), (files) =>
            files
              .filter((file) => file !== "SKILL.md" && !file.startsWith("."))
              .sort()
              .slice(0, 100),
          ),
        ),
        Match.exhaustive,
      );
    });
    const load = Effect.fn("Skills.load")(function* (project: Project) {
      // Later scopes win on a shared name: the app's defaults, then the user's, then the project's.
      const layers = [
        yield* scan("builtin", builtinRoot),
        yield* scan("global", globalSkillsDirectory(home)),
        yield* scan("project", projectSkillsDirectory(project.root)),
      ];
      const byName = MutableHashMap.fromIterable(
        layers.flatMap((layer) => layer.skills).map((entry) => [entry.skill.name, entry] as const),
      );
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
        const entry = EffectArray.findFirst(
          (yield* load(project)).entries,
          (candidate) => candidate.skill.name === name,
        );
        return yield* Option.match(entry, {
          onNone: () => Effect.succeed(null),
          onSome: (found) =>
            Effect.map(filesOf(found.skill), (files) => ({
              ...found.skill,
              body: found.body,
              files,
            })),
        });
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
