import { Function as EffectFunction } from "effect";
import { randomUUID } from "../runtime/synchronous-crypto.ts";
import { isTruthy } from "../truthy.ts";
import { toolDefinition, type ToolExecutionContext } from "@tanstack/ai";
import { tmpdir } from "node:os";
import { path } from "../runtime/synchronous-path.ts";
const { isAbsolute, relative, sep } = path;
import { Context, Effect, Result, Layer, Schema } from "effect";
import { BackgroundTasks, backgroundOperation, type BackgroundBinding } from "./background.ts";
import { StorageRoot } from "../config/storage-root.ts";
import {
  canonicalPath,
  PathRejected,
  resolveOutsidePath,
  resolveProjectPath,
} from "../files/paths.ts";
import {
  createTextFileEffect,
  deleteTextFileEffect,
  replaceTextFileEffect,
} from "../files/text.ts";
import type { Project } from "../projects/projects.ts";
import { defaultTimeoutSeconds, maxTimeoutSeconds, runCommand } from "../shell/run.ts";
import { ShellSkills, skillCommand } from "../skills/shell-skills.ts";
import {
  approvalToolDefinitions,
  reviewedToolDefinitions,
  RunSkillInput,
  type DeleteOutsideFileInput,
  type SaveShellSkillInput,
  type WriteOutsideFileInput,
} from "./definitions.ts";
import { guarded } from "./failure.ts";
import { toToolSchema } from "./schema.ts";

/** Not gated per call: the script it runs was approved when it was saved. */
export const runSkillDefinition = toolDefinition({
  name: "run_skill",
  description:
    "Run a project shell skill's scripts/run.sh with arguments ($1, $2, …, never shell-parsed). A script runs only as it was approved when saved; an edited or unapproved one is refused until saved again with save_shell_skill. Returns the output and exit status, or a taskId if still running after yieldMs (default 1000); retrieve the final result with get_background_result. A running receipt does not prove success.",
  inputSchema: toToolSchema(RunSkillInput),
});

const ShellResult = Schema.Struct({
  workdir: Schema.String,
  command: Schema.String,
  shell: Schema.String,
  status: Schema.Literals(["succeeded", "failed", "timed_out", "cancelled"]),
  exitCode: Schema.NullOr(Schema.Finite),
  signal: Schema.NullOr(Schema.String),
  durationMs: Schema.Finite,
  stdout: Schema.String,
  stderr: Schema.String,
  stdoutTruncated: Schema.Boolean,
  stderrTruncated: Schema.Boolean,
});

const isSameOrBelow = (root: string, candidate: string) => {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

/** Project-relative directories plus host temp directories are valid shell working directories. */
export const resolveShellWorkingDirectory: {
  (
    storageRoot: string,
    workdir: string,
  ): (projectRoot: string) => ReturnType<typeof resolveShellWorkingDirectoryBody>;
} & typeof resolveShellWorkingDirectoryBody = EffectFunction.dual(
  3,
  resolveShellWorkingDirectoryBody,
);
function resolveShellWorkingDirectoryBody(
  projectRoot: string,
  storageRoot: string,
  workdir: string,
) {
  if (!isAbsolute(workdir)) return resolveProjectPath(projectRoot, workdir, "directory");
  const resolved = resolveOutsidePath(projectRoot, storageRoot, workdir, "directory");
  const tempRoots = [canonicalPath("/tmp"), canonicalPath(tmpdir())];
  return Result.flatMap(resolved, (directory) =>
    tempRoots.some((root) => isSameOrBelow(root, directory.absolute))
      ? Result.succeed({
          absolute: directory.absolute,
          relative: directory.absolute,
          stats: directory.stats,
        })
      : Result.fail(new PathRejected({ path: workdir, reason: "invalid_path" })),
  );
}

const make = Effect.gen(function* () {
  const storage = yield* StorageRoot;
  const background = yield* BackgroundTasks;
  const shellSkills = yield* ShellSkills;

  return {
    /**
     * Server side of the approval-gated tools. With `static` approval (`ask` mode) TanStack waits
     * for the user; with `gate` (`auto`/`full` modes, subagents) middleware either reviews the call
     * or full mode lets it proceed. Permission mode never lifts path, credential or `.git` rules.
     */
    forProject(
      project: Project,
      approval: "static" | "gate" = project.permissionMode === "ask" ? "static" : "gate",
      binding?: BackgroundBinding,
    ) {
      const saveShellSkill = ({
        name,
        description,
        script,
        usage,
      }: typeof SaveShellSkillInput.Type) =>
        // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
        guarded(name, () => shellSkills.save(project, { name, description, script, usage }));

      const runSkill = (
        { name, args = [], workdir, timeoutSeconds, yieldMs }: typeof RunSkillInput.Type,
        context?: ToolExecutionContext,
      ) =>
        // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
        guarded(name, () =>
          Effect.gen(function* () {
            const runnable = yield* shellSkills.runnable(project, name);
            const command = skillCommand(name, runnable.text, args);
            const label = [name, ...args].join(" ");
            const directory = yield* Effect.fromResult(
              resolveShellWorkingDirectory(project.root, storage.path, workdir ?? "."),
            );
            const seconds = Math.min(
              Math.max(1, timeoutSeconds ?? defaultTimeoutSeconds),
              maxTimeoutSeconds,
            );
            const execute = (signal: AbortSignal | undefined) =>
              runCommand(command, {
                cwd: directory.absolute,
                timeoutSeconds: seconds,
                signal,
                env: process.env,
              });
            if (binding !== undefined) {
              const receipt = yield* background.start(
                binding,
                context?.toolCallId ?? randomUUID(),
                "shell",
                label,
                backgroundOperation(execute).pipe(
                  Effect.map((result) =>
                    JSON.stringify({ workdir: directory.relative, ...result, command: label }),
                  ),
                ),
              );
              const result = yield* background.waitResult(
                binding.sessionId,
                receipt.taskId,
                yieldMs ?? 1000,
              );
              if (result?.status === "completed")
                return yield* Schema.decodeEffect(Schema.fromJsonString(ShellResult))(
                  result.result,
                );
              if (isTruthy(result)) return { taskId: receipt.taskId, ...result };
              return receipt;
            }
            const result = yield* Effect.tryPromise(() => execute(context?.abortSignal));
            return { workdir: directory.relative, ...result, command: label };
          }),
        );

      const writeOutsideFile = ({
        path,
        content,
        expectedSha256,
      }: typeof WriteOutsideFileInput.Type) =>
        // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
        guarded(path, () =>
          Effect.gen(function* () {
            const target = yield* Effect.fromResult(
              resolveOutsidePath(project.root, storage.path, path, "new-or-file"),
            );
            if (expectedSha256 === undefined) {
              const created = yield* createTextFileEffect({
                absolute: target.absolute,
                path,
                text: content,
              });
              return { path: target.absolute, created: true, ...created };
            }
            if (!(target.stats !== undefined))
              return yield* new PathRejected({ path, reason: "not_found" });
            const replaced = yield* replaceTextFileEffect({
              absolute: target.absolute,
              path,
              expectedSha256,
              text: content,
            });
            return { path: target.absolute, created: false, ...replaced };
          }),
        );

      const deleteOutsideFile = ({ path, expectedSha256 }: typeof DeleteOutsideFileInput.Type) =>
        // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
        guarded(path, () =>
          Effect.gen(function* () {
            const target = yield* Effect.fromResult(
              resolveOutsidePath(project.root, storage.path, path, "file"),
            );
            const removed = yield* deleteTextFileEffect({
              absolute: target.absolute,
              path,
              expectedSha256,
            });
            return { path: target.absolute, deleted: true, ...removed };
          }),
        );

      if (approval === "gate") {
        const [save, write, remove] = reviewedToolDefinitions;
        return [
          save.server(saveShellSkill),
          runSkillDefinition.server(runSkill),
          write.server(writeOutsideFile),
          remove.server(deleteOutsideFile),
        ] as const;
      }
      const [save, write, remove] = approvalToolDefinitions;
      return [
        save.server(saveShellSkill),
        runSkillDefinition.server(runSkill),
        write.server(writeOutsideFile),
        remove.server(deleteOutsideFile),
      ] as const;
    },
  };
});

/** Shell skills and outside writes: saving a skill and every outside write is approval-gated. */
export class ApprovedTools extends Context.Service<ApprovedTools, Effect.Success<typeof make>>()(
  "memory-agent/tools/approved/ApprovedTools",
) {
  static readonly layer = Layer.effect(ApprovedTools, make);
}
