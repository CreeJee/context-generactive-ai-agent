import type { ChatMiddleware } from "@tanstack/ai";
import { glob } from "node:fs/promises";
import { sep } from "node:path";
import { Result, Schema } from "effect";
import { isCredentialPath, resolveProjectPath } from "../files/paths.ts";
import { readTextFile } from "../files/text.ts";

const prefix = "[Project AGENTS.md instructions]";

/** SDK boundary: load root guidance and a path catalog once per conversation run. */
export function projectInstructions(root: string): ChatMiddleware {
  let instructions: string | undefined;
  return {
    name: "memory-agent/project-instructions",
    async onConfig(_ctx, config) {
      if (instructions === undefined) {
        const resolved = resolveProjectPath(root, "AGENTS.md", "new-or-file");
        if (Result.isFailure(resolved)) throw resolved.failure;
        const rootText = resolved.success.stats
          ? (await readTextFile(resolved.success.absolute, "AGENTS.md")).text
          : "";
        const paths: string[] = [];
        for await (const entry of glob("**/AGENTS.md", {
          cwd: root,
          exclude: (path) =>
            isCredentialPath(path) ||
            path.split(/[\\/]/).some((part) => part === "node_modules" || part === ".git"),
        })) {
          const path = entry.split(sep).join("/");
          if (path !== "AGENTS.md" && Result.isSuccess(resolveProjectPath(root, path, "file")))
            paths.push(path);
        }
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
    },
  };
}
