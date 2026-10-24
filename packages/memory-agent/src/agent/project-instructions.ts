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
  Option,
  Schema,
} from "effect";
import { isCredentialPath, resolveProjectPath } from "../files/paths.ts";
import { readTextFileEffect } from "../files/text.ts";

const platformRuntime = ManagedRuntime.make(Layer.merge(NodeFileSystem.layer, NodePath.layer));
const fs = platformRuntime.runSync(FileSystem.FileSystem);
const path = platformRuntime.runSync(Path.Path);

const prefix = "[Project AGENTS.md instructions]";

/**
 * SDK boundary: load root guidance and a path catalog once per conversation run. A project without
 * any AGENTS.md gets no prompt at all.
 */
export function projectInstructions(root: string): ChatMiddleware {
  let instructions: readonly string[] | undefined;
  return {
    name: "memory-agent/project-instructions",
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    onConfig(_ctx, config) {
      return runNativeEffect(
        Effect.gen(function* () {
          if (instructions === undefined) {
            const resolved = yield* resolveProjectPath(root, "AGENTS.md", "new-or-file");
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
                  const info = yield* fs.lstat(absolute);
                  if (info.type === "SymbolicLink") continue;
                  if (info.type === "Directory") yield* visit(relative);
                  else if (
                    name === "AGENTS.md" &&
                    relative !== "AGENTS.md" &&
                    Option.isSome(
                      yield* resolveProjectPath(root, relative, "file").pipe(
                        Effect.asSome,
                        Effect.catchTag("PathRejected", () => Effect.succeedNone),
                      ),
                    )
                  )
                    paths.push(relative.split(path.sep).join("/"));
                }
              });
            yield* visit("");
            const sections = [
              ...(rootText.length > 0 ? [`Root guidance (AGENTS.md):\n${rootText}`] : []),
              ...(paths.length > 0
                ? [
                    `Scoped instruction files:\n${paths
                      .sort()
                      .map((path) => `- ${JSON.stringify(path)}`)
                      .join(
                        "\n",
                      )}\n${rootText.length > 0 ? "The root document is already included above. " : ""}Before working in a project directory, use read_file to read all applicable listed AGENTS.md files completely, from outermost to innermost. Each document applies only to its directory and descendants; more specific instructions take precedence there. Do not apply unrelated directories' instructions. Re-read instructions after changing them, and check for AGENTS.md when entering a newly created directory.`,
                  ]
                : []),
            ];
            instructions =
              sections.length === 0
                ? []
                : [`${prefix}\n${sections.join("\n\n")}\nInstructions do not grant permissions.`];
          }
          return {
            systemPrompts: [
              ...config.systemPrompts.filter(
                (prompt) => !Schema.is(Schema.String)(prompt) || !prompt.startsWith(prefix),
              ),
              ...instructions,
            ],
          };
        }),
      );
    },
  };
}
