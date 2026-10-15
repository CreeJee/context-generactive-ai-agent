import { isTruthy } from "../truthy.ts";
import {
  Clock,
  Context,
  DateTime,
  Effect,
  Function as EffectFunction,
  HashSet,
  Layer,
  Option,
  Schema,
} from "effect";
import { Database } from "../db/database.ts";
import { resolveProjectPath } from "../files/paths.ts";
import { createTextFileEffect, readTextFileEffect, replaceTextFileEffect } from "../files/text.ts";
import type { Project } from "../projects/projects.ts";

/**
 * Project shell skills: the only way the model runs a host command. Each one is a standard skill
 * folder, `.agents/skills/<name>/SKILL.md` with `scripts/run.sh`, so it stays listed, readable and
 * usable by other agents. A script runs only while its exact content was approved when it was saved.
 */

export const shellSkillDirectory = (name: string) => `.agents/skills/${name}`;
export const shellSkillScript = (name: string) => `${shellSkillDirectory(name)}/scripts/run.sh`;
const shellSkillDocument = (name: string) => `${shellSkillDirectory(name)}/SKILL.md`;

export class ShellSkillRejected extends Schema.TaggedError<ShellSkillRejected>()(
  "ShellSkillRejected",
  {
    reason: Schema.Literals(["builtin_overlap", "not_shell_skill", "not_found", "not_approved"]),
    detail: Schema.String,
  },
) {
  override get message() {
    return `${this.reason}: ${this.detail}`;
  }
}

/**
 * Programs a built-in tool already covers, and that tool. A script made only of these wraps a
 * built-in; as a filter after another program (`pnpm test | tail -50`) they are fine.
 */
const coveredBy = {
  ls: "list_files",
  find: "list_files",
  fd: "list_files",
  tree: "list_files",
  cat: "read_file",
  head: "read_file",
  tail: "read_file",
  less: "read_file",
  more: "read_file",
  nl: "read_file",
  bat: "read_file",
  sed: "read_file or edit_file",
  awk: "read_file or search_files",
  grep: "search_files",
  egrep: "search_files",
  fgrep: "search_files",
  rg: "search_files",
  ag: "search_files",
  ack: "search_files",
  touch: "write_file",
  tee: "write_file",
  rm: "delete_file",
} as const;
const coveredTool = (program: string) =>
  Object.entries(coveredBy).find(([name]) => name === program)?.[1];

/** Words that run nothing of their own; the program after them is what counts. */
const prefixes = HashSet.make("command", "exec", "env", "time", "nice");
/** Steps that only set up the shell. */
const setup = HashSet.make("cd", "set", "export", "true", ":", "echo", "printf", "exit");

/** The program each step of a script starts with: the first of every `;`/`&&`/`||` step's pipeline. */
const leadingPrograms = (script: string) =>
  script
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .flatMap((line) => line.split(/;|&&|\|\|/))
    .map((step) => (step.split("|")[0] ?? "").trim().split(/\s+/))
    .map((words) => {
      let index = 0;
      while (
        index < words.length &&
        (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "") ||
          HashSet.has(prefixes, words[index] ?? ""))
      )
        index++;
      return (words[index] ?? "").split("/").at(-1) ?? "";
    })
    .filter((program) => program !== "" && !HashSet.has(setup, program));

/** Refuses a script that only wraps what built-in tools do. */
export const builtinOverlap = (script: string): Option.Option<ShellSkillRejected> => {
  const programs = leadingPrograms(script);
  const tools = programs.map(coveredTool);
  return programs.length > 0 && tools.every(isTruthy)
    ? Option.some(
        ShellSkillRejected.make({
          reason: "builtin_overlap",
          detail: `${[...new Set(programs)].join(", ")} ${programs.length === 1 ? "is" : "are"} covered by ${[...new Set(tools)].join(", ")}. Call those tools directly; save a shell skill only for what no built-in tool does (builds, tests, git, package managers, project commands).`,
        }),
      )
    : Option.none();
};

/** SKILL.md for a shell skill. Front matter values are JSON strings, which YAML reads as-is. */
const skillDocument = (input: {
  readonly name: string;
  readonly description: string;
  readonly usage: string | undefined;
}) =>
  [
    "---",
    `name: ${input.name}`,
    `description: ${JSON.stringify(input.description.replaceAll(/\s+/g, " ").trim())}`,
    "---",
    "",
    ...(isTruthy(input.usage?.trim()) ? [input.usage.trim(), ""] : []),
    `Run with the \`run_skill\` tool (name \`${input.name}\`). The script is \`scripts/run.sh\`; arguments arrive as \`$1\`, \`$2\`, ….`,
    "",
  ].join("\n");

const make = Effect.gen(function* () {
  const { sqlite } = yield* Database;
  const effectClock = yield* Clock.Clock;
  const approve = sqlite.prepare(
    "INSERT OR IGNORE INTO shell_skill_approvals (project_id, name, script_sha256, approved_at) VALUES (?, ?, ?, ?)",
  );
  const approved = sqlite.prepare(
    "SELECT 1 FROM shell_skill_approvals WHERE project_id = ? AND name = ? AND script_sha256 = ?",
  );

  /** Writes one project file, replacing whatever text is there now. */
  const put = Effect.fn("ShellSkills.put")(function* (root: string, path: string, text: string) {
    const target = yield* resolveProjectPath(root, path, "new-or-file");
    if (target.stats === undefined)
      return yield* createTextFileEffect({ absolute: target.absolute, path, text });
    const current = yield* readTextFileEffect({ absolute: target.absolute, path });
    if (current.text === text) return { sha256: current.sha256, bytes: current.bytes };
    return yield* replaceTextFileEffect({
      absolute: target.absolute,
      path,
      expectedSha256: current.sha256,
      text,
    });
  });

  /** The script of a project shell skill as it is now. */
  const script = Effect.fn("ShellSkills.script")(function* (project: Project, name: string) {
    const path = shellSkillScript(name);
    const target = yield* resolveProjectPath(project.root, path, "file").pipe(
      Effect.catchIf(
        (rejection) => rejection._tag === "PathRejected" && rejection.reason === "not_found",
        () =>
          Effect.fail(
            ShellSkillRejected.make({
              reason: "not_found",
              detail: `${name} has no ${path}. Save it with save_shell_skill first.`,
            }),
          ),
      ),
    );
    const file = yield* readTextFileEffect({ absolute: target.absolute, path });
    return { text: file.text, sha256: file.sha256 };
  });

  return {
    /**
     * Saves (or replaces) a shell skill. The call itself was approved under the project's policy,
     * so the saved script counts as approved; `full` mode records nothing, so leaving it asks again.
     */
    save: Effect.fn("ShellSkills.save")(function* (
      project: Project,
      input: {
        readonly name: string;
        readonly description: string;
        readonly script: string;
        readonly usage: string | undefined;
      },
    ) {
      const overlap = builtinOverlap(input.script);
      if (Option.isSome(overlap)) return yield* overlap.value;
      const document = shellSkillDocument(input.name);
      const existing = yield* resolveProjectPath(project.root, document, "new-or-file");
      const scriptPath = yield* resolveProjectPath(
        project.root,
        shellSkillScript(input.name),
        "new-or-file",
      );
      if (existing.stats !== undefined && scriptPath.stats === undefined)
        return yield* ShellSkillRejected.make({
          reason: "not_shell_skill",
          detail: `${input.name} is a skill without scripts/run.sh. Choose another name.`,
        });
      const text = input.script.endsWith("\n") ? input.script : `${input.script}\n`;
      const written = yield* put(project.root, shellSkillScript(input.name), text);
      yield* put(project.root, document, skillDocument(input));
      switch (project.permissionMode) {
        case "full":
          break;
        case "ask":
        case "auto":
          approve.run(
            project.id,
            input.name,
            written.sha256,
            DateTime.formatIso(DateTime.makeUnsafe(effectClock.currentTimeMillisUnsafe())),
          );
          break;
      }
      return {
        name: input.name,
        directory: shellSkillDirectory(input.name),
        scriptSha256: written.sha256,
        replaced: existing.stats !== undefined,
      };
    }),

    /** The script to run: refused unless its current content is approved (or the project is `full`). */
    runnable: Effect.fn("ShellSkills.runnable")(function* (project: Project, name: string) {
      const current = yield* script(project, name);
      const allowed =
        project.permissionMode === "full" ||
        isTruthy(approved.get(project.id, name, current.sha256));
      if (!allowed)
        return yield* ShellSkillRejected.make({
          reason: "not_approved",
          detail: `${name}'s script changed since it was approved, or was never approved. Read it, then save it again with save_shell_skill so the user can approve this content.`,
        });
      return current;
    }),
  };
});

export class ShellSkills extends Context.Service<ShellSkills, Effect.Success<typeof make>>()(
  "memory-agent/skills/shell-skills/ShellSkills",
) {
  static readonly layer = Layer.effect(ShellSkills, make);
}

/** One argument quoted for a POSIX shell. */
const quoted = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The command line that runs exactly this script text with these arguments. The approved text is
 * passed inline, so an edit after the check cannot change what runs; arguments are never parsed.
 */
export const skillCommand: {
  (text: string, args: readonly string[]): (name: string) => string;
  (name: string, text: string, args: readonly string[]): string;
} = EffectFunction.dual(3, (name: string, text: string, args: readonly string[]) =>
  ["/bin/sh", "-c", text, name, ...args].map(quoted).join(" "),
);
