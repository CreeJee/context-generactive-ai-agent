/**
 * Definitions of the tools that need the user's approval before they run (R04/R05).
 *
 * This module is safe to import in the browser: the chat UI registers these same definitions so
 * TanStack can match an approval interrupt to its tool by schema hash and let the user answer it.
 * The server implementations live in `approved.ts`.
 */
import { defineInterrupt, toolDefinition } from "@tanstack/ai";
import { Schema } from "effect";
import { toToolSchema } from "./schema.ts";

export { attachmentIdOf, attachmentUrl } from "../attachments/urls.ts";
export {
  contextUsageEvent,
  serverRestartedCode,
  type CancelResult,
  type CompactResult,
  type ContextView,
  type SessionRunState,
} from "../agent/run-state.ts";
export { sessionHolderHeader, type LeaseView } from "../sessions/lease-state.ts";
export type { SubagentStatus, SubagentView } from "../subagents/subagent-state.ts";
export type { ApprovalRequester, RelayedApprovalView } from "../approvals/relayed-state.ts";
export {
  queueDeliveredEvent,
  type DeliveryVia,
  type QueueEdit,
  type QueueItemState,
  type QueuedMessage,
  type QueueSnapshot,
} from "../queue/queue-state.ts";

export const RunShellInput = Schema.Struct({
  command: Schema.NonEmptyString.annotate({
    description: "Shell script to execute on the host.",
  }),
  workdir: Schema.optionalKey(
    Schema.String.annotate({
      description:
        'Project-relative directory or absolute directory below /tmp to run in. Defaults to the project root (".").',
    }),
  ),
  timeoutSeconds: Schema.optionalKey(
    Schema.Int.annotate({
      description: "Stop the command after this long. 120 by default, at most 1800.",
    }),
  ),
  yieldMs: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 30_000 }))).annotate({
      description:
        "Return a background task receipt if unfinished after this many milliseconds (default 1000). 0 dispatches immediately. This is separate from the command's timeoutSeconds. Retrieve with get_background_result; only finished results prove checks passed.",
    }),
  ),
  reason: Schema.optionalKey(
    Schema.String.annotate({
      description: "One sentence on why, shown to the user when asking.",
    }),
  ),
});

export const WriteOutsideFileInput = Schema.Struct({
  path: Schema.String.annotate({ description: "Absolute path outside the project." }),
  content: Schema.String.annotate({ description: "The complete new file content." }),
  expectedSha256: Schema.optionalKey(
    Schema.String.annotate({
      description: "Required to replace an existing file: the sha256 from read_outside_file.",
    }),
  ),
  reason: Schema.optionalKey(
    Schema.String.annotate({
      description: "One sentence on why, shown to the user when asking.",
    }),
  ),
});

export const DeleteOutsideFileInput = Schema.Struct({
  path: Schema.String.annotate({ description: "Absolute path outside the project." }),
  expectedSha256: Schema.String.annotate({
    description: "sha256 from read_outside_file; the file is only deleted if it still matches.",
  }),
  reason: Schema.optionalKey(
    Schema.String.annotate({
      description: "One sentence on why, shown to the user when asking.",
    }),
  ),
});

const runShell = {
  name: "run_shell",
  description:
    "Execute a finite, non-interactive shell script in the working directory. Returns its output and exit status, or a taskId if still running after yieldMs (default 1000); retrieve the final result with get_background_result. timeoutSeconds limits execution. Not for interactive input, sign-in, servers or watchers. Execution follows the project's approval policy. A running receipt does not prove success.",
  inputSchema: toToolSchema(RunShellInput),
} as const;

const writeOutsideFile = {
  name: "write_outside_file",
  description:
    "Create a text file outside the project, or replace one when expectedSha256 is given. Each write is approved first. Credential files are refused even with approval.",
  inputSchema: toToolSchema(WriteOutsideFileInput),
} as const;

const deleteOutsideFile = {
  name: "delete_outside_file",
  description:
    "Delete one text file outside the project whose content still matches expectedSha256. Each deletion is approved first.",
  inputSchema: toToolSchema(DeleteOutsideFileInput),
} as const;

/** Names of the tools that never run without an approval, in either permission mode. */
export const gatedToolNames: ReadonlySet<string> = new Set([
  runShell.name,
  writeOutsideFile.name,
  deleteOutsideFile.name,
]);

export const runShellDefinition = toolDefinition({ ...runShell, needsApproval: true });
export const writeOutsideFileDefinition = toolDefinition({
  ...writeOutsideFile,
  needsApproval: true,
});
export const deleteOutsideFileDefinition = toolDefinition({
  ...deleteOutsideFile,
  needsApproval: true,
});

/**
 * `ask` mode: TanStack pauses before each call until the user answers.
 * Register these with `useChat({ tools })` so approval requests can be answered.
 */
export const approvalToolDefinitions = [
  runShellDefinition,
  writeOutsideFileDefinition,
  deleteOutsideFileDefinition,
] as const;

/**
 * `auto` mode: the same tools without TanStack's static approval. The permission review
 * middleware decides each call instead, and asks the user through {@link permissionReviewInterrupt}.
 */
export const reviewedToolDefinitions = [
  toolDefinition({ ...runShell, needsApproval: false }),
  toolDefinition({ ...writeOutsideFile, needsApproval: false }),
  toolDefinition({ ...deleteOutsideFile, needsApproval: false }),
] as const;

export const PermissionReviewPayload = Schema.Struct({
  toolCallId: Schema.String,
  toolName: Schema.String,
  /** The call's arguments as JSON, exactly as the model sent them. */
  arguments: Schema.String,
  /** Why the review wants the user to decide. */
  reason: Schema.String,
  /**
   * `review`: the permission review was unsure. `every_call`: the tool asks on every call (MCP
   * tools in `ask` mode). Absent on requests stored before this existed, which were all reviews.
   */
  askedBy: Schema.optionalKey(Schema.Literals(["review", "every_call"])),
});

export const PermissionReviewResponse = Schema.Struct({ approved: Schema.Boolean });

/** `auto` mode: the review could not allow a call on its own and asks the user. */
export const permissionReviewInterrupt = defineInterrupt({
  id: "permission-review",
  payloadSchema: toToolSchema(PermissionReviewPayload),
  responseSchema: toToolSchema(PermissionReviewResponse),
});
