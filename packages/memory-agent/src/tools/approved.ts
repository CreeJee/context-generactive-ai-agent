import type { ToolExecutionContext } from "@tanstack/ai";
import { tmpdir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import { Context, Effect, Result, Layer } from "effect";
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

  return {
    /**
     * Server side of the approval-gated tools. With `static` approval (`ask` mode) TanStack waits
     * for the user; with `gate` (`auto`/`full` modes, subagents) middleware either reviews the call
     * or full mode lets it proceed. Permission mode never lifts path, credential or `.git` rules.
     */
    forProject(
      project: Project,
      approval: "static" | "gate" = project.permissionMode === "ask" ? "static" : "gate",
    ) {
      const runShell = (
        { command, workdir, timeoutSeconds }: typeof RunShellInput.Type,
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
          const result = await runCommand(command, {
            cwd: directory.absolute,
            timeoutSeconds: seconds,
            signal: context?.abortSignal,
            env: process.env,
          });
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
