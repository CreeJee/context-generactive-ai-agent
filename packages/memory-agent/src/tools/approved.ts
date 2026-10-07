import { Function as EffectFunction } from "effect";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { randomUUID } from "node:crypto";
import { isTruthy } from "../truthy.ts";
import type { ToolExecutionContext } from "@tanstack/ai";
import { tmpdir } from "node:os";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { isAbsolute, relative, sep } from "node:path";
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
import {
  approvalToolDefinitions,
  reviewedToolDefinitions,
  type DeleteOutsideFileInput,
  type RunShellInput,
  type WriteOutsideFileInput,
} from "./definitions.ts";
import { guarded } from "./failure.ts";

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
      const runShell = (
        { command, workdir, timeoutSeconds, yieldMs }: typeof RunShellInput.Type,
        context?: ToolExecutionContext,
      ) =>
        // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
        guarded(workdir ?? ".", () =>
          Effect.gen(function* () {
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
              return yield* Effect.gen(function* () {
                const receipt = yield* background.start(
                  binding,
                  context?.toolCallId ?? randomUUID(),
                  "shell",
                  command,
                  backgroundOperation(execute).pipe(
                    Effect.map((result) =>
                      JSON.stringify({ workdir: directory.relative, ...result }),
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
              });
            }
            const result = yield* Effect.tryPromise(() => execute(context?.abortSignal));
            return { workdir: directory.relative, ...result };
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
        const [shell, write, remove] = reviewedToolDefinitions;
        return [
          shell.server(runShell),
          write.server(writeOutsideFile),
          remove.server(deleteOutsideFile),
        ] as const;
      }
      const [shell, write, remove] = approvalToolDefinitions;
      return [
        shell.server(runShell),
        write.server(writeOutsideFile),
        remove.server(deleteOutsideFile),
      ] as const;
    },
  };
});

/** Shell and outside-write tools, each run gated by an approval. */
export class ApprovedTools extends Context.Service<ApprovedTools, Effect.Success<typeof make>>()(
  "memory-agent/tools/approved/ApprovedTools",
) {
  static readonly layer = Layer.effect(ApprovedTools, make);
}
