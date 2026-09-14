/**
 * Definitions of the tools that need the user's approval before they run (R04/R05).
 *
 * This module is safe to import in the browser: the chat UI registers these same definitions so
 * TanStack can match an approval interrupt to its tool by schema hash and let the user answer it.
 * The server implementations live in `approved.ts`.
 */
import { toolDefinition } from "@tanstack/ai";
import { Schema } from "effect";
import { toToolSchema } from "./schema.ts";

export const RunShellInput = Schema.Struct({
  command: Schema.NonEmptyString.annotations({
    description: "Shell command line, run with the user's shell on the host (not sandboxed).",
  }),
  workdir: Schema.optional(
    Schema.String.annotations({
      description: 'Project-relative directory to run in. Defaults to the project root (".").',
    }),
  ),
  timeoutSeconds: Schema.optional(
    Schema.Int.annotations({
      description: "Stop the command after this long. 120 by default, at most 1800.",
    }),
  ),
  reason: Schema.optional(
    Schema.String.annotations({
      description: "One sentence on why, shown to the user when asking.",
    }),
  ),
});

export const WriteOutsideFileInput = Schema.Struct({
  path: Schema.String.annotations({ description: "Absolute path outside the project." }),
  content: Schema.String.annotations({ description: "The complete new file content." }),
  expectedSha256: Schema.optional(
    Schema.String.annotations({
      description: "Required to replace an existing file: the sha256 from read_outside_file.",
    }),
  ),
  reason: Schema.optional(
    Schema.String.annotations({
      description: "One sentence on why, shown to the user when asking.",
    }),
  ),
});

export const DeleteOutsideFileInput = Schema.Struct({
  path: Schema.String.annotations({ description: "Absolute path outside the project." }),
  expectedSha256: Schema.String.annotations({
    description: "sha256 from read_outside_file; the file is only deleted if it still matches.",
  }),
  reason: Schema.optional(
    Schema.String.annotations({
      description: "One sentence on why, shown to the user when asking.",
    }),
  ),
});

export const runShellDefinition = toolDefinition({
  name: "run_shell",
  description:
    "Run a shell command in the project on the host, for builds, tests, git and other programs. The user approves each run. Returns exit code, signal and output (long output keeps its start and end).",
  inputSchema: toToolSchema(RunShellInput),
  needsApproval: true,
});

export const writeOutsideFileDefinition = toolDefinition({
  name: "write_outside_file",
  description:
    "Create a text file outside the project, or replace one when expectedSha256 is given. The user approves each write. Credential files are refused even with approval.",
  inputSchema: toToolSchema(WriteOutsideFileInput),
  needsApproval: true,
});

export const deleteOutsideFileDefinition = toolDefinition({
  name: "delete_outside_file",
  description:
    "Delete one text file outside the project whose content still matches expectedSha256. The user approves each deletion.",
  inputSchema: toToolSchema(DeleteOutsideFileInput),
  needsApproval: true,
});

/** Register these with `useChat({ tools })` so approval requests can be answered. */
export const approvalToolDefinitions = [
  runShellDefinition,
  writeOutsideFileDefinition,
  deleteOutsideFileDefinition,
] as const;
