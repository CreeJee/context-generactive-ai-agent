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
export { runHasFailure, runPlace, spanLine, spanTotalLine } from "../report/bundle-digest.ts";
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

/** A sh skill: a script that runs a host command again and again, approved once. */
export const ShSkillProgram = Schema.Struct({
  runtime: Schema.Literal("sh"),
  script: Schema.NonEmptyString.annotate({
    description:
      "POSIX sh script for one job, run in the working directory with arguments as $1, $2, …. Name project files by paths relative to it, never by the project's absolute path. Print only what the task needs: filter or cap noisy output in the script.",
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
        'A sh skill\'s directory to run in: relative to the project, absolute inside it, or absolute below a temporary folder such as /tmp. Defaults to the project root (".").',
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

export const RunCommandInput = Schema.Struct({
  script: Schema.NonEmptyString.annotate({
    description:
      "POSIX sh script, run once exactly as written in the working directory. Name project files by paths relative to it.",
  }),
  access: Schema.Literals(["read", "write"]).annotate({
    description:
      '"read": the script only looks. It runs without asking, writes nothing outside temporary folders, has no network and cannot read credential-named files. "write": the script may change project files and reach the hosts in network; the call is approved first.',
  }),
  network: Schema.optionalKey(
    Schema.Array(NetworkHost).check(Schema.isMaxLength(32)).annotate({
      description:
        'With access "write" only: the only hosts the script may connect to, exactly as it needs them (e.g. "registry.npmjs.org", "*.github.com"). Omit for no network; localhost only if listed.',
    }),
  ),
  workdir: Schema.optionalKey(
    Schema.String.annotate({
      description:
        'The directory to run in: relative to the project, absolute inside it, or absolute below a temporary folder such as /tmp. Defaults to the project root (".").',
    }),
  ),
  timeoutSeconds: Schema.optionalKey(
    Schema.Int.annotate({
      description: "Stop the script after this long. 120 by default, at most 1800.",
    }),
  ),
  yieldMs: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 30_000 }))).annotate({
      description:
        "Return a background taskId if the script is unfinished after this many milliseconds (default 1000; 0 dispatches at once). Separate from timeoutSeconds.",
    }),
  ),
  reason: Schema.optionalKey(
    Schema.String.annotate({
      description: 'With access "write": one sentence on why, shown to the user when asking.',
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
    "Save a code skill (SKILL.md with scripts/run.ts or scripts/run.sh) for run_skill to run. The app keeps it for this conversation: its runs, and the cards and verifiers of its Goal, can run it; a review later decides whether the project's other conversations get it. Make each skill one purpose-specific job, reuse a listed skill when one fits, and do not wrap a single tool call. A ts skill is a program that calls your tools as functions, as in run_code, with the input it declares. A sh skill is a script for a host command you will run again with other arguments (tests, builds, installs); a command you run once goes to run_command instead. It runs sandboxed, writes only inside the project, temp folders and package caches, cannot read credential folders or the app's storage, and reaches only the hosts in network. Saving asks for approval of the exact program and host list; later runs of the unchanged program, with any input or arguments, do not ask. Saving under an existing skill's name replaces it for this conversation. Read the code-skill-writing skill before the first save in a conversation.",
  parameters: SaveCodeSkillInput,
} as const;

export const runCommandSpec = {
  name: "run_command",
  description:
    'Run a sh script once on the host, in a sandbox, without saving it. access "read" is for looking: git status, diff, log and show, tool versions, anything that changes no file. It runs without asking; its sandbox writes nothing outside temporary folders, has no network and cannot read credential-named files. access "write" is for a script that changes project files or needs the network (the hosts in network): each call is approved first, so a command you will run again with other arguments belongs in a code skill (save_code_skill, then run_skill), which is approved once. A script made only of what your file tools do (ls, cat, grep, find, rm, …) is refused: call those tools. What the sandbox blocked is listed in stderr under <sandbox_violations>; a "read" script that was blocked from writing needs access "write". It returns the output and exit status, or a taskId if still running after yieldMs; retrieve the final result with get_background_result. A running receipt does not prove success.',
  parameters: RunCommandInput,
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

/**
 * Names of the tools that never run without an approval, in either permission mode. A run_command
 * call that only looks (access "read") is the exception its call plan makes (`approved.ts`).
 */
export const gatedToolNames = HashSet.fromIterable([
  saveCodeSkillSpec.name,
  runCommandSpec.name,
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
