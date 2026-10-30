/**
 * Definitions of the tools that need the user's approval before they run (R04/R05), with the
 * contracts the chat UI shares with the server.
 *
 * This module is safe to import in the browser. The server implementations live in `approved.ts`.
 */
import { HashSet, Schema } from "effect";

export { attachmentIdOf, attachmentUrl } from "../attachments/urls.ts";
export {
  contextUsageEvent,
  serverRestartedCode,
  type CancelResult,
  type CompactResult,
  type ContextView,
  type SessionRunState,
} from "../agent/run-state.ts";
export {
  ReportDiagnosis,
  ReportDiagnosisFailure,
  ReportDiagnosisInput,
} from "../report/diagnosis-contract.ts";
export {
  ReportBundle,
  BundleEvent,
  type BundleRun,
  type BundleText,
} from "../report/bundle-contract.ts";
export { runHasFailure, runPlace } from "../report/bundle-digest.ts";
export {
  ReportDeliveryFailure,
  ReportDeliveryResult,
  ReportDeliveryStatus,
} from "../report/delivery-contract.ts";
export type {
  UncertainContinue,
  UncertainRun,
  UncertainTool,
  UncertainToolState,
} from "../workflow/uncertain-runs.ts";
export { sessionHolderHeader, type LeaseView } from "../sessions/lease-state.ts";
export {
  ConfigFileFailureCode,
  ExternalAgentFailureCode,
  McpFailureCode,
  McpLoginFailureCode,
  RunFailureCode,
  externalAgentFailureText,
  runFailureCodeOf,
  runFailureText,
  type ShownFailure,
} from "../runtime/shown-failure.ts";
export type { SubagentStatus, SubagentView } from "../subagents/subagent-state.ts";
export { loopRetrySchedule, type LoopHealth } from "../runtime/loop-health.ts";
export type { ProviderRetryView } from "../workflow/provider-retry.ts";
export { ApprovalRequester, type RelayedApprovalView } from "../approvals/relayed-state.ts";
export {
  queueDeliveredEvent,
  NextDelivery,
  QueueEdit,
  QueueItemState,
  type DeliveryVia,
  type QueuedMessage,
  type QueueSnapshot,
} from "../queue/queue-state.ts";

/** Skill names as the Agent Skills format spells them: lowercase words joined by hyphens. */
const SkillName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  Schema.isMaxLength(64),
);

/** A host a sandboxed script may connect to: a lowercase name or `*.` wildcard, optionally `:port`. */
export const NetworkHost = Schema.String.check(
  Schema.isPattern(/^(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::[0-9]{1,5})?$/),
  Schema.isMaxLength(253),
);

/** A JSON object as the model writes it: a skill's input, or the JSON Schema that describes it. */
const JsonObject = Schema.Record(Schema.String, Schema.Unknown);

/** A ts skill: a program that calls the run's tools, as run_code runs one. */
export const TsSkillProgram = Schema.Struct({
  runtime: Schema.Literal("ts"),
  code: Schema.NonEmptyString.annotate({
    description:
      "TypeScript for one job: the body of an async function that reads `input`, calls tools as `await external_<tool name>(input)` and returns a small JSON value.",
  }),
  input: Schema.optionalKey(
    JsonObject.annotate({
      description:
        'JSON Schema of `input`, of type "object"; every run is checked against it. Omit when the skill takes no input.',
    }),
  ),
});

/** A sh skill: a script, the only way a host command runs. */
export const ShSkillProgram = Schema.Struct({
  runtime: Schema.Literal("sh"),
  script: Schema.NonEmptyString.annotate({
    description:
      "POSIX sh script for one job, run in the working directory with arguments as $1, $2, …. Print only what the task needs: filter or cap noisy output in the script.",
  }),
  network: Schema.optionalKey(
    Schema.Array(NetworkHost).check(Schema.isMaxLength(32)).annotate({
      description:
        'The only hosts the script may connect to, exactly as it needs them (e.g. "registry.npmjs.org", "*.github.com", "api.example.com:443"). Omit for no network; localhost only if listed.',
    }),
  ),
});

export const SaveCodeSkillInput = Schema.Struct({
  name: SkillName.annotate({
    description:
      "Skill name: lowercase words joined by hyphens, naming the job (e.g. test-failures, package-exports).",
  }),
  description: Schema.NonEmptyString.annotate({
    description:
      "One line on what the skill does and when to use it; it is listed so later runs can find it.",
  }),
  program: Schema.Union([TsSkillProgram, ShSkillProgram]).annotate({
    description:
      "ts for work done with your tools (reading, changing and checking files, combining results, running sh skills); sh only for host commands no tool runs: builds, tests, git, package managers.",
  }),
  usage: Schema.optionalKey(
    Schema.String.annotate({
      description: "What the input or arguments mean and what the result shows.",
    }),
  ),
  reason: Schema.optionalKey(
    Schema.String.annotate({
      description: "One sentence on why, shown to the user when asking.",
    }),
  ),
});

export const RunSkillInput = Schema.Struct({
  name: SkillName.annotate({ description: "A project code skill's name." }),
  input: Schema.optionalKey(
    JsonObject.annotate({ description: "A ts skill's input, as its Input in the list says." }),
  ),
  args: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description: "A sh skill's arguments, passed as $1, $2, … without shell parsing.",
    }),
  ),
  workdir: Schema.optionalKey(
    Schema.String.annotate({
      description:
        'A sh skill\'s directory to run in: project-relative, or absolute below /tmp. Defaults to the project root (".").',
    }),
  ),
  timeoutSeconds: Schema.optionalKey(
    Schema.Int.annotate({
      description: "Stop the skill after this long. 120 by default, at most 1800.",
    }),
  ),
  yieldMs: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 30_000 }))).annotate({
      description:
        "A sh skill returns a background taskId if unfinished after this many milliseconds (default 1000; 0 dispatches at once). Separate from timeoutSeconds.",
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

/** The gated tools' names, descriptions and parameters, which their Effect AI tools share. */
export const saveCodeSkillSpec = {
  name: "save_code_skill",
  description:
    "Save a project code skill (.agents/skills/<name>/ with SKILL.md and scripts/run.ts or scripts/run.sh) for run_skill to run. Make each skill one purpose-specific job, reuse a listed skill when one fits, and do not wrap a single tool call. A ts skill is a program that calls your tools as functions, as in run_code, with the input it declares. A sh skill is a script, the only way to run host commands: it runs sandboxed, writes only inside the project, temp folders and package caches, cannot read credential folders or the app's storage, and reaches only the hosts in network. Saving asks for approval of the exact program and host list; later runs of the unchanged program, with any input or arguments, do not ask. Saving under an existing skill's name replaces it. Read the code-skill-writing skill before the first save in a conversation.",
  parameters: SaveCodeSkillInput,
} as const;

export const writeOutsideFileSpec = {
  name: "write_outside_file",
  description:
    "Create a text file outside the project, or replace one when expectedSha256 is given. Each write is approved first. Credential files are refused even with approval.",
  parameters: WriteOutsideFileInput,
} as const;

export const deleteOutsideFileSpec = {
  name: "delete_outside_file",
  description:
    "Delete one text file outside the project whose content still matches expectedSha256. Each deletion is approved first.",
  parameters: DeleteOutsideFileInput,
} as const;

/** Names of the tools that never run without an approval, in either permission mode. */
export const gatedToolNames = HashSet.fromIterable([
  saveCodeSkillSpec.name,
  writeOutsideFileSpec.name,
  deleteOutsideFileSpec.name,
]);

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
export { reportedTitle, ScanState, sourceLabels } from "../improve/contracts.ts";
export type { ScanFailure } from "../improve/contracts.ts";
