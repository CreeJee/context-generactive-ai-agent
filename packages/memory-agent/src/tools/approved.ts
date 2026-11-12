import { Array as Arr, Context, Effect, FileSystem, Layer, Match, Option, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import { ChildProcessSpawner } from "effect/process";
import {
  BackgroundOperationFailed,
  BackgroundTasks,
  type BackgroundBinding,
} from "./background.ts";
import { StorageRoot } from "../config/storage-root.ts";
import {
  folderMentions,
  isPlainPath,
  mapUserFolderMentions,
  projectPathOf,
  resolveOutsideToolPath,
  resolveWorkingDirectory,
} from "../files/path-policy.ts";
import { PathRejected, type Fenced } from "../files/paths.ts";
import { optionalProperty } from "../optional-property.ts";
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
  deleteOutsideFileSpec,
  RunSkillInput,
  saveCodeSkillSpec,
  writeOutsideFileSpec,
  type DeleteOutsideFileInput,
  type SaveCodeSkillInput,
  type WriteOutsideFileInput,
} from "./definitions.ts";
import { guardedChange, guardedEffect } from "./failure.ts";
import { FileTools } from "./files.ts";
import { byPathPlace } from "./outside.ts";
import { CallPlan, runTool } from "./run-tool.ts";

/** Not gated per call: the program it runs was approved when it was saved. */
const runSkill = {
  name: "run_skill",
  description:
    "Run a project code skill. A skill runs only as it was approved when saved; an edited or unapproved one is refused until saved again with save_code_skill. A ts skill takes input, checked against its schema, and returns what its program returned, as run_code does; it always runs to the end within timeoutSeconds and never moves to the background. A sh skill takes args and runs sandboxed: what the sandbox blocked is listed in stderr under <sandbox_violations>; to reach a blocked host the job needs, save the skill again with that host in network. It returns the output and exit status, or a taskId if still running after yieldMs; retrieve the final result with get_background_result. A running receipt does not prove success.",
  parameters: RunSkillInput,
} as const;

const ShellResult = Schema.Struct({
  workdir: Schema.String,
  pathMapped: Schema.optionalKey(Schema.String),
  pathWarning: Schema.optionalKey(Schema.String),
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

const make = Effect.gen(function* () {
  const storage = yield* StorageRoot;
  const files = yield* FileTools;
  const background = yield* BackgroundTasks;
  const codeSkills = yield* CodeSkills;
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* Effect.context<FileSystem.FileSystem | SecureRandom.SecureRandom>();

  /**
   * An outside write or delete whose path lands in the project does only what write_file or
   * delete_file does, which asks nothing: it runs with the project-relative path, so it cannot
   * reach outside the project when it runs even if the path changed since.
   */
  const projectChange =
    (project: Fenced<Project>) =>
    <P extends { readonly path: string }>(params: P) =>
      projectPathOf(project, params.path).pipe(
        Effect.map(
          Option.match({
            onSome: (below) => CallPlan.Ungated({ params: { ...params, path: below } }),
            onNone: () => CallPlan.AsGiven<P>(),
          }),
        ),
        Effect.orElseSucceed(() => CallPlan.AsGiven<P>()),
        Effect.provideContext(platform),
      );

  /** The approved tools' calls for `project`, each failing with what the model reads. */
  const callsFor = (project: Fenced<Project>, binding?: BackgroundBinding) => ({
    saveCodeSkill: ({ name, description, program, usage }: typeof SaveCodeSkillInput.Type) =>
      guardedEffect(name, codeSkills.save(project, { name, description, usage, program })),

    /** Interrupting the call stops the command. */
    runSkill: (
      { name, args = [], workdir, timeoutSeconds, yieldMs }: typeof RunSkillInput.Type,
      toolCallId: string,
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
          const label = [name, ...args].join(" ");
          const directory = yield* resolveWorkingDirectory(
            project,
            storage.path,
            workdir ?? ".",
          ).pipe(Effect.provideContext(platform));
          // In a card, a script that names the user's project folder runs with that folder written
          // as the card's own copy, as the file tools read such a path (`path-policy.ts`), except
          // where it names a file only the user's folder has (`.env`, `node_modules`), which it
          // reads there. Only those paths of the approved text change. A copy whose path cannot
          // take their place in a script runs the script as approved, with a warning.
          const userFolder = (yield* folderMentions(project, runnable.text).pipe(
            Effect.provideContext(platform),
          )).filter(({ folder }) => folder === "user");
          const spellings = Arr.dedupe(userFolder.map(({ spelling }) => spelling)).join(", ");
          const named = Option.liftPredicate(userFolder, Arr.isReadonlyArrayNonEmpty);
          const mapsFolder = Option.isSome(named) && isPlainPath(project.root);
          const script = yield* mapsFolder
            ? mapUserFolderMentions(project, runnable.text, userFolder, project.root).pipe(
                Effect.provideContext(platform),
              )
            : Effect.succeed({ text: runnable.text, mapped: [], readInUserFolder: [] });
          const command = skillCommand(name, script.text, args);
          const scriptNotes = [
            ...(Arr.isReadonlyArrayNonEmpty(script.mapped)
              ? [
                  `This skill's script names the user's project folder (${spellings}). This run works in a kanban card's own copy of the project, so the script ran with that folder as ${project.root}.`,
                ]
              : []),
            ...(Arr.isReadonlyArrayNonEmpty(script.readInUserFolder)
              ? [
                  `This card's copy of the project does not have these paths, because git does not track them (like .env or node_modules), so the script read them in the user's project folder, where it cannot write: ${script.readInUserFolder.join(", ")}.`,
                ]
              : []),
          ];
          const mapped = {
            ...optionalProperty(
              "pathMapped",
              Option.getOrUndefined(
                Option.map(
                  Option.liftPredicate(
                    [...Option.toArray(directory.mappedNote), ...scriptNotes],
                    Arr.isReadonlyArrayNonEmpty,
                  ),
                  (notes) => notes.join(" "),
                ),
              ),
            ),
            ...optionalProperty(
              "pathWarning",
              Option.getOrUndefined(
                Option.map(
                  Option.filter(named, () => !mapsFolder),
                  () =>
                    `This skill's script names the user's project folder by its absolute path (${spellings}). This run works in a kanban card's own copy of the project, whose path cannot replace it in the script, so the script may read the user's folder instead of this copy, and the sandbox refuses writes there. Save the skill again with paths relative to its working directory.`,
                ),
              ),
            ),
          };
          const seconds = Math.min(
            Math.max(1, timeoutSeconds ?? defaultTimeoutSeconds),
            maxTimeoutSeconds,
          );
          const runLine = (line: string) =>
            runCommand({
              command: line,
              cwd: directory.absolute,
              timeoutSeconds: seconds,
              env: process.env,
            });
          const setup = {
            command,
            commandId: toolCallId,
            ...(yield* sandboxPolicy({
              projectRoot: project.root,
              storageRoot: storage.path,
              network: runnable.network,
            }).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem))),
          };
          // Without an OS sandbox here, only `full` mode, which already runs unapproved scripts,
          // falls back to running the script as it is.
          type LineRun = ReturnType<typeof runLine>;
          const execute = runSandboxed(setup, runLine).pipe(
            Effect.catchTag(
              "SandboxUnavailable",
              (
                unavailable,
              ): Effect.Effect<
                CommandResult,
                SandboxUnavailable | Effect.Error<LineRun>,
                Effect.Services<LineRun>
              > =>
                project.permissionMode === "full" ? runLine(command) : Effect.fail(unavailable),
            ),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
          const inBackground = (bound: BackgroundBinding) =>
            Effect.gen(function* () {
              const receipt = yield* background.start(
                bound,
                toolCallId,
                "shell",
                label,
                execute.pipe(
                  Effect.mapError((cause) => BackgroundOperationFailed.make({ cause })),
                  Effect.map((result) =>
                    JSON.stringify({
                      workdir: directory.relative,
                      ...mapped,
                      ...result,
                      command: label,
                    }),
                  ),
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
          const inline = Effect.map(execute, (result) => ({
            workdir: directory.relative,
            ...mapped,
            ...result,
            command: label,
          }));
          return yield* Option.match(Option.fromNullishOr(binding), {
            onNone: () => inline,
            onSome: inBackground,
          });
        }),
      ),

    /**
     * A path in the project is written as write_file writes it; its call needed no approval
     * (`projectChange`). One outside the project was approved for this exact path.
     */
    writeOutsideFile: ({ path, content, expectedSha256 }: typeof WriteOutsideFileInput.Type) =>
      byPathPlace(
        project,
        path,
        "write_file",
        files
          .callsFor(project)
          .writeFile({ path, content, ...optionalProperty("expectedSha256", expectedSha256) }),
        guardedChange(
          path,
          Effect.gen(function* () {
            const target = yield* resolveOutsideToolPath(
              project,
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
                  Effect.map((replaced) => ({
                    path: target.absolute,
                    created: false,
                    ...replaced,
                  })),
                ),
            });
          }).pipe(Effect.provideContext(platform)),
        ),
      ).pipe(Effect.provideContext(platform)),

    /** A path in the project is deleted as delete_file deletes it, like {@link writeOutsideFile}. */
    deleteOutsideFile: ({ path, expectedSha256 }: typeof DeleteOutsideFileInput.Type) =>
      byPathPlace(
        project,
        path,
        "delete_file",
        files.callsFor(project).deleteFile({ path, expectedSha256 }),
        guardedChange(
          path,
          Effect.gen(function* () {
            const target = yield* resolveOutsideToolPath(project, storage.path, path, "file");
            const removed = yield* deleteTextFileEffect({
              absolute: target.absolute,
              path,
              expectedSha256,
            });
            return { path: target.absolute, deleted: true, ...removed };
          }).pipe(Effect.provideContext(platform)),
        ),
      ).pipe(Effect.provideContext(platform)),
  });

  return {
    /**
     * The approval-gated tools. With `static` approval (`ask` mode) the gated tools carry
     * `needsApproval`, which the loop asks the user about; with `gate` (`auto`/`full` modes,
     * subagents) the loop's review decides each call, or full mode lets it proceed. Permission mode
     * never lifts path, credential or `.git` rules. They run on the loop's fiber, so their spans
     * join the run's trace.
     */
    toolsFor: (
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
          // The approval shows the program as it will be saved.
          plan: (input) =>
            codeSkills.rewritten(project, input.program).pipe(
              Effect.map(
                Option.match({
                  onNone: () => CallPlan.AsGiven<typeof input>(),
                  onSome: (program) => CallPlan.Rewritten({ params: { ...input, program } }),
                }),
              ),
              Effect.orElseSucceed(() => CallPlan.AsGiven<typeof input>()),
            ),
          handler: calls.saveCodeSkill,
        }),
        runTool({
          ...runSkill,
          handler: (input, call) => calls.runSkill(input, call.toolCallId),
        }),
        runTool({
          ...writeOutsideFileSpec,
          needsApproval,
          lazy: true,
          plan: projectChange(project),
          handler: calls.writeOutsideFile,
        }),
        runTool({
          ...deleteOutsideFileSpec,
          needsApproval,
          lazy: true,
          plan: projectChange(project),
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
