import { Function as EffectFunction } from "effect";
import { randomUUID } from "../runtime/synchronous-crypto.ts";
import { toolDefinition } from "@tanstack/ai";
import { path } from "../runtime/synchronous-path.ts";
const { isAbsolute, relative, sep } = path;
import { Cause, Context, Effect, FileSystem, Layer, Match, Option, Schema } from "effect";
import { AttemptFailureReason } from "../work-trace/contracts.ts";
import { BackgroundTasks, backgroundOperation, type BackgroundBinding } from "./background.ts";
import { StorageRoot } from "../config/storage-root.ts";
import { temporaryDirectory } from "../runtime/host-system.ts";
import {
  canonicalPathEffect,
  PathRejected,
  resolveFencedOutsidePath,
  resolveOutsidePath,
  type Fenced,
  resolveProjectPath,
} from "../files/paths.ts";
import {
  createTextFileEffect,
  deleteTextFileEffect,
  replaceTextFileEffect,
} from "../files/text.ts";
import type { Project } from "../projects/projects.ts";
import {
  defaultTimeoutSeconds,
  maxTimeoutSeconds,
  runCommand,
  type CommandResult,
} from "../shell/run.ts";
import { runSandboxed, sandboxPolicy, type SandboxUnavailable } from "../shell/sandbox.ts";
import {
  CodeSkillRejected,
  CodeSkills,
  SavedProgram,
  skillCommand,
} from "../skills/code-skills.ts";
import {
  approvalToolDefinitions,
  deleteOutsideFileSpec,
  reviewedToolDefinitions,
  RunSkillInput,
  saveCodeSkillSpec,
  writeOutsideFileSpec,
  type DeleteOutsideFileInput,
  type SaveCodeSkillInput,
  type WriteOutsideFileInput,
} from "./definitions.ts";
import { runNativeEffectWith } from "../runtime/native-effect.ts";
import { runTrace } from "../runtime/run-trace.ts";
import { guardedEffect } from "./failure.ts";
import { lazily } from "./lazy.ts";
import { runTool } from "./run-tool.ts";
import { definitionOf } from "./schema.ts";

const runSkill = {
  name: "run_skill",
  description:
    "Run a project code skill. A skill runs only as it was approved when saved; an edited or unapproved one is refused until saved again with save_code_skill. A ts skill takes input, checked against its schema, and returns what its program returned, as run_code does. A sh skill takes args and runs sandboxed: what the sandbox blocked is listed in stderr under <sandbox_violations>; to reach a blocked host the job needs, save the skill again with that host in network. It returns the output and exit status, or a taskId if still running after yieldMs; retrieve the final result with get_background_result. A running receipt does not prove success.",
  parameters: RunSkillInput,
} as const;

/** Not gated per call: the program it runs was approved when it was saved. */
export const runSkillDefinition = toolDefinition(definitionOf(runSkill));

const ShellResult = Schema.Struct({
  workdir: Schema.String,
  command: Schema.String,
  shell: Schema.String,
  status: Schema.Literals(["succeeded", "failed", "timed_out", "cancelled"]),
  exitCode: Schema.NullOr(Schema.Finite),
  signal: Schema.NullOr(Schema.String),
  durationMs: Schema.Finite,
  stdout: Schema.String,
  stderr: Schema.String,
  stdoutTruncated: Schema.Boolean,
  stderrTruncated: Schema.Boolean,
});

/** A background command that did not exit cleanly fails its attempt; its output is still kept. */
const commandFailure = Match.type<CommandResult>().pipe(
  Match.discriminatorsExhaustive("status")({
    succeeded: (): AttemptFailureReason | null => null,
    cancelled: () => null,
    failed: ({ exitCode, signal }) =>
      AttemptFailureReason.cases.ProcessExited.make({ exitCode, signal }),
    timed_out: () => AttemptFailureReason.cases.ProcessTimedOut.make({}),
  }),
);

const isSameOrBelow = (root: string, candidate: string) => {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

/** Project-relative directories plus host temp directories are valid shell working directories. */
export const resolveShellWorkingDirectory: {
  (
    storageRoot: string,
    workdir: string,
  ): (projectRoot: string) => ReturnType<typeof resolveShellWorkingDirectoryBody>;
} & typeof resolveShellWorkingDirectoryBody = EffectFunction.dual(
  3,
  resolveShellWorkingDirectoryBody,
);
function resolveShellWorkingDirectoryBody(
  projectRoot: string,
  storageRoot: string,
  workdir: string,
) {
  return isAbsolute(workdir)
    ? outsideWorkingDirectory(projectRoot, storageRoot, workdir)
    : resolveProjectPath(projectRoot, workdir, "directory");
}

/** An absolute working directory, which must be under a temporary directory. */
function outsideWorkingDirectory(projectRoot: string, storageRoot: string, workdir: string) {
  return Effect.gen(function* () {
    const directory = yield* resolveOutsidePath(projectRoot, storageRoot, workdir, "directory");
    const tempRoots = yield* Effect.all(
      [canonicalPathEffect("/tmp"), Effect.flatMap(temporaryDirectory, canonicalPathEffect)],
      { concurrency: 2 },
    );
    return yield* tempRoots.some((root) => isSameOrBelow(root, directory.absolute))
      ? Effect.succeed({
          absolute: directory.absolute,
          relative: directory.absolute,
          stats: directory.stats,
        })
      : Effect.fail(PathRejected.make({ path: workdir, reason: "invalid_path" }));
  });
}

const make = Effect.gen(function* () {
  const storage = yield* StorageRoot;
  const background = yield* BackgroundTasks;
  const codeSkills = yield* CodeSkills;
  const fileSystem = yield* FileSystem.FileSystem;

  /** The approved tools' calls for `project`, each failing with what the model reads. */
  const callsFor = (project: Fenced<Project>, binding?: BackgroundBinding) => ({
    saveCodeSkill: ({ name, description, program, usage }: typeof SaveCodeSkillInput.Type) =>
      guardedEffect(name, codeSkills.save(project, { name, description, usage, program })),

    /**
     * `signal` stops the command when the caller is cancelled; without one, interrupting the call
     * stops it.
     */
    runSkill: (
      { name, args = [], workdir, timeoutSeconds, yieldMs }: typeof RunSkillInput.Type,
      toolCallId: string | undefined,
      signal: AbortSignal | undefined,
    ) =>
      guardedEffect(
        name,
        Effect.gen(function* () {
          // A ts skill is run by `CodeTools`, which knows the run's tools; one reaches here
          // only from a program, which runs sh skills alone.
          const runnable = yield* SavedProgram.$match(yield* codeSkills.runnable(project, name), {
            ts: () =>
              Effect.fail(
                CodeSkillRejected.make({
                  reason: "ts_skill",
                  detail: `${name} is a ts skill, which a program cannot run. Call run_skill for it yourself.`,
                }),
              ),
            sh: (saved) => Effect.succeed(saved),
          });
          const command = skillCommand(name, runnable.text, args);
          const label = [name, ...args].join(" ");
          const directory = yield* resolveShellWorkingDirectory(
            project.root,
            storage.path,
            workdir ?? ".",
          );
          const seconds = Math.min(
            Math.max(1, timeoutSeconds ?? defaultTimeoutSeconds),
            maxTimeoutSeconds,
          );
          const runLine = (signal: AbortSignal | undefined) => (line: string) =>
            Effect.tryPromise(() =>
              runCommand(line, {
                cwd: directory.absolute,
                timeoutSeconds: seconds,
                signal,
                env: process.env,
              }),
            );
          const setup = {
            command,
            commandId: toolCallId ?? randomUUID(),
            ...(yield* sandboxPolicy({
              projectRoot: project.root,
              storageRoot: storage.path,
              network: runnable.network,
            })),
          };
          // Without an OS sandbox here, only `full` mode, which already runs unapproved scripts,
          // falls back to running the script as it is.
          const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
          const execute = (signal: AbortSignal | undefined) =>
            runPromise(
              runSandboxed(setup, runLine(signal)).pipe(
                Effect.catchTag(
                  "SandboxUnavailable",
                  (
                    unavailable,
                  ): Effect.Effect<CommandResult, SandboxUnavailable | Cause.UnknownError> =>
                    project.permissionMode === "full"
                      ? runLine(signal)(command)
                      : Effect.fail(unavailable),
                ),
                Effect.provideService(FileSystem.FileSystem, fileSystem),
              ),
            );
          const inBackground = (bound: BackgroundBinding) =>
            Effect.gen(function* () {
              const receipt = yield* background.start(
                bound,
                toolCallId ?? randomUUID(),
                "shell",
                label,
                backgroundOperation(execute).pipe(
                  Effect.map((result) => ({
                    report: JSON.stringify({
                      workdir: directory.relative,
                      ...result,
                      command: label,
                    }),
                    failure: commandFailure(result),
                  })),
                ),
              );
              const saved = yield* background.waitResult(
                bound.sessionId,
                receipt.taskId,
                yieldMs ?? 1000,
              );
              return yield* Option.match(Option.fromNullishOr(saved), {
                onNone: () => Effect.succeed(receipt),
                onSome: (result) =>
                  Match.value(result).pipe(
                    Match.when({ status: "completed" }, ({ result: text }) =>
                      Schema.decodeEffect(Schema.fromJsonString(ShellResult))(text),
                    ),
                    Match.orElse((running) =>
                      Effect.succeed({ taskId: receipt.taskId, ...running }),
                    ),
                  ),
              });
            });
          const inline = Effect.map(
            Effect.tryPromise((interrupted) => execute(signal ?? interrupted)),
            (result) => ({ workdir: directory.relative, ...result, command: label }),
          );
          return yield* Option.match(Option.fromNullishOr(binding), {
            onNone: () => inline,
            onSome: inBackground,
          });
        }),
      ),

    writeOutsideFile: ({ path, content, expectedSha256 }: typeof WriteOutsideFileInput.Type) =>
      guardedEffect(
        path,
        Effect.gen(function* () {
          const target = yield* resolveFencedOutsidePath(
            project.toolFence,
            project.root,
            storage.path,
            path,
            "new-or-file",
          );
          // Without a hash the file must be new; with one it replaces the file it names.
          return yield* Option.match(Option.fromNullishOr(expectedSha256), {
            onNone: () =>
              Effect.map(
                createTextFileEffect({ absolute: target.absolute, path, text: content }),
                (created) => ({ path: target.absolute, created: true, ...created }),
              ),
            onSome: (expected) =>
              Effect.succeed(target).pipe(
                Effect.filterOrFail(
                  (existing) => existing.stats !== undefined,
                  () => PathRejected.make({ path, reason: "not_found" }),
                ),
                Effect.andThen(
                  replaceTextFileEffect({
                    absolute: target.absolute,
                    path,
                    expectedSha256: expected,
                    text: content,
                  }),
                ),
                Effect.map((replaced) => ({ path: target.absolute, created: false, ...replaced })),
              ),
          });
        }),
      ),

    deleteOutsideFile: ({ path, expectedSha256 }: typeof DeleteOutsideFileInput.Type) =>
      guardedEffect(
        path,
        Effect.gen(function* () {
          const target = yield* resolveFencedOutsidePath(
            project.toolFence,
            project.root,
            storage.path,
            path,
            "file",
          );
          const removed = yield* deleteTextFileEffect({
            absolute: target.absolute,
            path,
            expectedSha256,
          });
          return { path: target.absolute, deleted: true, ...removed };
        }),
      ),
  });

  return {
    /**
     * Server side of the approval-gated tools. With `static` approval (`ask` mode) TanStack waits
     * for the user; with `gate` (`auto`/`full` modes, subagents) middleware either reviews the call
     * or full mode lets it proceed. Permission mode never lifts path, credential or `.git` rules.
     * They run on the run's context, so their spans join the run's trace.
     */
    forProject: (
      project: Fenced<Project>,
      approval: "static" | "gate" = project.permissionMode === "ask" ? "static" : "gate",
      binding?: BackgroundBinding,
    ) =>
      Effect.map(runTrace, (caller) => {
        const calls = callsFor(project, binding);
        // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
        const run = runNativeEffectWith(caller);
        const saveCodeSkill = (input: typeof SaveCodeSkillInput.Type) =>
          run(calls.saveCodeSkill(input));
        const runSkill = runSkillDefinition.server((input, context) =>
          run(calls.runSkill(input, context?.toolCallId, context?.abortSignal)),
        );
        const writeOutsideFile = (input: typeof WriteOutsideFileInput.Type) =>
          run(calls.writeOutsideFile(input));
        const deleteOutsideFile = (input: typeof DeleteOutsideFileInput.Type) =>
          run(calls.deleteOutsideFile(input));

        const [save, write, remove] =
          approval === "gate" ? reviewedToolDefinitions : approvalToolDefinitions;
        return [
          lazily(save.server(saveCodeSkill)),
          runSkill,
          lazily(write.server(writeOutsideFile)),
          lazily(remove.server(deleteOutsideFile)),
        ] as const;
      }),

    /**
     * {@link forProject} for the Effect AI loop (docs/effect-ai-migration.md step 3). With `static`
     * approval the gated tools carry `needsApproval`, which the loop asks the user about; with
     * `gate` the loop's review decides each call.
     */
    runToolsFor: (
      project: Fenced<Project>,
      approval: "static" | "gate" = project.permissionMode === "ask" ? "static" : "gate",
      binding?: BackgroundBinding,
    ) => {
      const calls = callsFor(project, binding);
      const needsApproval = approval === "static";
      return [
        runTool({
          ...saveCodeSkillSpec,
          needsApproval,
          lazy: true,
          handler: calls.saveCodeSkill,
        }),
        runTool({
          ...runSkill,
          handler: (input, call) => calls.runSkill(input, call.toolCallId, undefined),
        }),
        runTool({
          ...writeOutsideFileSpec,
          needsApproval,
          lazy: true,
          handler: calls.writeOutsideFile,
        }),
        runTool({
          ...deleteOutsideFileSpec,
          needsApproval,
          lazy: true,
          handler: calls.deleteOutsideFile,
        }),
      ];
    },
  };
});

/** Code skills and outside writes: saving a skill and every outside write is approval-gated. */
export class ApprovedTools extends Context.Service<ApprovedTools, Effect.Success<typeof make>>()(
  "memory-agent/tools/approved/ApprovedTools",
) {
  static readonly layer = Layer.effect(ApprovedTools, make);
}
