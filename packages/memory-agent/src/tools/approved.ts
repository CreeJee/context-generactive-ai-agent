import { Context, Effect, Layer } from "effect";
import { StorageRoot } from "../config/storage-root.ts";
import { resolveOutsidePath, resolveProjectPath, PathRejected } from "../files/paths.ts";
import { createTextFile, deleteTextFile, replaceTextFile } from "../files/text.ts";
import type { Project } from "../projects/projects.ts";
import { defaultTimeoutSeconds, maxTimeoutSeconds, runCommand } from "../shell/run.ts";
import {
  deleteOutsideFileDefinition,
  runShellDefinition,
  writeOutsideFileDefinition,
} from "./definitions.ts";
import { guarded, orThrow } from "./failure.ts";

const make = Effect.gen(function* () {
  const storage = yield* StorageRoot;

  return {
    /**
     * Server side of the approval-gated tools. TanStack pauses the run before any of these execute
     * and resumes only after the user approves that exact call, so these run knowing consent exists.
     * Approval never lifts the credential and `.git` rules.
     */
    forProject(project: Project) {
      const runShell = runShellDefinition.server(({ command, workdir, timeoutSeconds }, context) =>
        guarded(workdir ?? ".", async () => {
          const directory = orThrow(resolveProjectPath(project.root, workdir ?? ".", "directory"));
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
        }),
      );

      const writeOutsideFile = writeOutsideFileDefinition.server(
        ({ path, content, expectedSha256 }) =>
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
          }),
      );

      const deleteOutsideFile = deleteOutsideFileDefinition.server(({ path, expectedSha256 }) =>
        guarded(path, async () => {
          const target = orThrow(resolveOutsidePath(project.root, storage.path, path, "file"));
          const removed = await deleteTextFile(target.absolute, path, expectedSha256);
          return { path: target.absolute, deleted: true, ...removed };
        }),
      );

      return [runShell, writeOutsideFile, deleteOutsideFile] as const;
    },
  };
});

/** Shell and outside-write tools, each run gated by the user's approval. */
export class ApprovedTools extends Context.Tag("memory-agent/ApprovedTools")<
  ApprovedTools,
  Effect.Effect.Success<typeof make>
>() {
  static readonly layer = Layer.effect(ApprovedTools, make);
}
