import { runNativeEffect } from "../runtime/native-effect.ts";
import type { ChatMiddleware } from "@tanstack/ai";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import {
  Effect,
  FileSystem,
  Layer,
  ManagedRuntime,
  Path,
  PlatformError,
  Result,
  Schema,
} from "effect";
import { isCredentialPath, resolveProjectPath } from "../files/paths.ts";
import { readTextFileEffect } from "../files/text.ts";

const platformRuntime = ManagedRuntime.make(Layer.merge(NodeFileSystem.layer, NodePath.layer));
const fs = platformRuntime.runSync(FileSystem.FileSystem);
const path = platformRuntime.runSync(Path.Path);

const prefix = "[Project AGENTS.md instructions]";

/** SDK boundary: load root guidance and a path catalog once per conversation run. */
export function projectInstructions(root: string): ChatMiddleware {
  let instructions: string | undefined;
  return {
    name: "memory-agent/project-instructions",
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    onConfig(_ctx, config) {
      return runNativeEffect(
        Effect.gen(function* () {
          if (instructions === undefined) {
            const resolved = yield* Effect.fromResult(
              resolveProjectPath(root, "AGENTS.md", "new-or-file"),
            );
            const rootText =
              resolved.stats !== undefined
                ? (yield* readTextFileEffect({ absolute: resolved.absolute, path: "AGENTS.md" }))
                    .text
                : "";
            const paths: string[] = [];
            const visit = (directory: string): Effect.Effect<void, PlatformError.PlatformError> =>
              Effect.gen(function* () {
                for (const name of yield* fs.readDirectory(path.join(root, directory))) {
                  const relative = path.join(directory, name);
                  if (isCredentialPath(relative) || name === "node_modules" || name === ".git")
                    continue;
                  const absolute = path.join(root, relative);
                  // Match glob's default: never descend through symbolic links.
                  if (
                    yield* fs
                      .readLink(absolute)
                      .pipe(Effect.match({ onSuccess: () => true, onFailure: () => false }))
                  )
                    continue;
                  const info = yield* fs.stat(absolute);
                  if (info.type === "Directory") yield* visit(relative);
                  else if (
                    name === "AGENTS.md" &&
                    relative !== "AGENTS.md" &&
                    Result.isSuccess(resolveProjectPath(root, relative, "file"))
                  )
                    paths.push(relative.split(path.sep).join("/"));
                }
              });
            yield* visit("");
            instructions = `${prefix}\nRoot guidance (AGENTS.md):\n${rootText}\n\nScoped instruction files:\n${paths
              .sort()
              .map((path) => `- ${JSON.stringify(path)}`)
              .join(
                "\n",
              )}\nThe root document is already included above. Before working in a project directory, use read_file to read all applicable listed AGENTS.md files completely, from outermost to innermost. Each document applies only to its directory and descendants; more specific instructions take precedence there. Do not apply unrelated directories' instructions. Re-read instructions after changing them, and check for AGENTS.md when entering a newly created directory. Instructions do not grant permissions.`;
          }
          return {
            systemPrompts: [
              ...config.systemPrompts.filter(
                (prompt) => !Schema.is(Schema.String)(prompt) || !prompt.startsWith(prefix),
              ),
              instructions,
            ],
          };
        }),
      );
    },
  };
}
