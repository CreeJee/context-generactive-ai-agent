import { runNativeEffect } from "../runtime/native-effect.ts";
import type { ChatMiddleware } from "@tanstack/ai";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import {
  Array as Arr,
  Effect,
  FileSystem,
  Layer,
  ManagedRuntime,
  Match,
  Order,
  Path,
  PlatformError,
  Schema,
} from "effect";
import { isCredentialPath, resolveProjectPath } from "../files/paths.ts";
import { readTextFileEffect } from "../files/text.ts";
import { asRunFailed, type RunHook } from "../loop/run.ts";

const platformRuntime = ManagedRuntime.make(Layer.merge(NodeFileSystem.layer, NodePath.layer));
const fs = platformRuntime.runSync(FileSystem.FileSystem);
const path = platformRuntime.runSync(Path.Path);

const prefix = "[Project AGENTS.md instructions]";

/** Places never searched for instruction files. */
const skipped = (relative: string, name: string) =>
  isCredentialPath(relative) || name === "node_modules" || name === ".git";

/** The AGENTS.md files below the root, as project paths. */
const scopedFiles = (root: string) => {
  const visit = (
    directory: string,
  ): Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError> =>
    Effect.flatMap(fs.readDirectory(path.join(root, directory)), (names) =>
      Effect.map(
        Effect.forEach(names, (name) => {
          const relative = path.join(directory, name);
          return skipped(relative, name)
            ? Effect.succeed([])
            : Effect.flatMap(fs.lstat(path.join(root, relative)), ({ type }) =>
                Match.value(type).pipe(
                  // Match glob's default: never descend through symbolic links.
                  Match.when("SymbolicLink", () => Effect.succeed([])),
                  Match.when("Directory", () => visit(relative)),
                  Match.orElse(() =>
                    name === "AGENTS.md" && relative !== "AGENTS.md"
                      ? resolveProjectPath(root, relative, "file").pipe(
                          Effect.as([relative.split(path.sep).join("/")]),
                          Effect.catchTag("PathRejected", () => Effect.succeed([])),
                        )
                      : Effect.succeed([]),
                  ),
                ),
              );
        }),
        Arr.flatten,
      ),
    );
  return visit("");
};

/**
 * The root guidance and a catalog of the scoped instruction files. A project without any AGENTS.md
 * gets no prompt at all.
 */
const instructionsFor = Effect.fnUntraced(function* (root: string) {
  const resolved = yield* resolveProjectPath(root, "AGENTS.md", "new-or-file");
  const rootText =
    resolved.stats === undefined
      ? ""
      : (yield* readTextFileEffect({ absolute: resolved.absolute, path: "AGENTS.md" })).text;
  const paths = Arr.sort(yield* scopedFiles(root), Order.String);
  const sections = [
    ...(rootText.length > 0 ? [`Root guidance (AGENTS.md):\n${rootText}`] : []),
    ...(paths.length > 0
      ? [
          `Scoped instruction files:\n${paths
            .map((path) => `- ${JSON.stringify(path)}`)
            .join(
              "\n",
            )}\n${rootText.length > 0 ? "The root document is already included above. " : ""}Before working in a project directory, use read_file to read all applicable listed AGENTS.md files completely, from outermost to innermost. Each document applies only to its directory and descendants; more specific instructions take precedence there. Do not apply unrelated directories' instructions. Re-read instructions after changing them, and check for AGENTS.md when entering a newly created directory.`,
        ]
      : []),
  ];
  return sections.length === 0
    ? []
    : [`${prefix}\n${sections.join("\n\n")}\nInstructions do not grant permissions.`];
});

/**
 * SDK boundary: load root guidance and a path catalog once per conversation run. A project without
 * any AGENTS.md gets no prompt at all.
 */
export function projectInstructions(root: string): ChatMiddleware {
  const instructions = Effect.runSync(Effect.cached(instructionsFor(root)));
  return {
    name: "memory-agent/project-instructions",
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    onConfig(_ctx, config) {
      return runNativeEffect(
        Effect.map(instructions, (added) => ({
          systemPrompts: [
            ...config.systemPrompts.filter(
              (prompt) => !Schema.is(Schema.String)(prompt) || !prompt.startsWith(prefix),
            ),
            ...added,
          ],
        })),
      );
    },
  };
}

/**
 * The same instructions for the Effect AI loop, read once per run and sent after the system prompts
 * the hooks before this one chose.
 */
export const projectInstructionsHook = (root: string) =>
  Effect.map(
    Effect.cached(Effect.mapError(instructionsFor(root), asRunFailed)),
    (instructions): RunHook => ({
      request: (_scope, request) =>
        Effect.map(instructions, (added) => ({
          ...request,
          system: [...request.system, ...added],
        })),
    }),
  );
