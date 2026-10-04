import type { ToolExecutionContext } from "@tanstack/ai";
import { tmpdir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import { Context, Effect, Result, Layer, Schema } from "effect";
import { BackgroundTasks, type BackgroundBinding } from "./background.ts";
import { StorageRoot } from "../config/storage-root.ts";
import {
  canonicalPath,
  PathRejected,
  resolveOutsidePath,
  resolveProjectPath,
} from "../files/paths.ts";
import { createTextFile, deleteTextFile, replaceTextFile } from "../files/text.ts";
import type { Project } from "../projects/projects.ts";
import { defaultTimeoutSeconds, maxTimeoutSeconds, runCommand } from "../shell/run.ts";
import {
  approvalToolDefinitions,
  reviewedToolDefinitions,
  type DeleteOutsideFileInput,
  type RunShellInput,
  type WriteOutsideFileInput,
} from "./definitions.ts";
import { guarded, orThrow } from "./failure.ts";

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
export function resolveShellWorkingDirectory(
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
  const services = yield* Effect.context<never>();
  const run = Effect.runPromiseWith(services);

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
        guarded(workdir ?? ".", async () => {
          const directory = orThrow(
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
          if (binding) {
            const receipt = await run(
              background.start(
                binding,
                context?.toolCallId ?? crypto.randomUUID(),
                "shell",
                command,
                async (signal) =>
                  JSON.stringify({ workdir: directory.relative, ...(await execute(signal)) }),
              ),
            );
            const result = await run(
              background.waitResult(binding.sessionId, receipt.taskId, yieldMs ?? 1000),
            );
            if (result?.status === "completed")
              return Schema.decodeUnknownSync(Schema.fromJsonString(ShellResult))(result.result);
            if (result) return { taskId: receipt.taskId, ...result };
            return receipt;
          }
          const result = await execute(context?.abortSignal);
          return { workdir: directory.relative, ...result };
        });

      const writeOutsideFile = ({
        path,
        content,
        expectedSha256,
      }: typeof WriteOutsideFileInput.Type) =>
        guarded(path, async () => {
          const target = orThrow(
            resolveOutsidePath(project.root, storage.path, path, "new-or-file"),
          );
          if (expectedSha256 === undefined) {
            const created = await createTextFile(target.absolute, path, content);
            return { path: target.absolute, created: true, ...created };
          }
          if (!target.stats) throw new PathRejected({ path, reason: "not_found" });
          const replaced = await replaceTextFile(target.absolute, path, expectedSha256, content);
          return { path: target.absolute, created: false, ...replaced };
        });

      const deleteOutsideFile = ({ path, expectedSha256 }: typeof DeleteOutsideFileInput.Type) =>
        guarded(path, async () => {
          const target = orThrow(resolveOutsidePath(project.root, storage.path, path, "file"));
          const removed = await deleteTextFile(target.absolute, path, expectedSha256);
          return { path: target.absolute, deleted: true, ...removed };
        });

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
  "memory-agent/ApprovedTools",
) {
  static readonly layer = Layer.effect(ApprovedTools, make);
}
