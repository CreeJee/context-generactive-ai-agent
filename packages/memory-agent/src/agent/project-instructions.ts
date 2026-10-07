import { runNativeEffect } from "../runtime/native-effect.ts";
import type { ChatMiddleware } from "@tanstack/ai";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { glob } from "node:fs/promises";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { sep } from "node:path";
import { Cause, Effect, Result, Schema, Stream } from "effect";
import { isCredentialPath, resolveProjectPath } from "../files/paths.ts";
import { readTextFileEffect } from "../files/text.ts";

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
            const paths = yield* Stream.runCollect(
              Stream.fromAsyncIterable(
                glob("**/AGENTS.md", {
                  cwd: root,
                  exclude: (path) =>
                    isCredentialPath(path) ||
                    path.split(/[\\/]/).some((part) => part === "node_modules" || part === ".git"),
                }),
                (cause) => new Cause.UnknownError(cause),
              ).pipe(
                Stream.map((entry) => entry.split(sep).join("/")),
                Stream.filter(
                  (path) =>
                    path !== "AGENTS.md" &&
                    Result.isSuccess(resolveProjectPath(root, path, "file")),
                ),
              ),
            );
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
