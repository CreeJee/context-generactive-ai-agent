import {
  Array as Arr,
  Clock,
  Context,
  DateTime,
  Effect,
  Function as EffectFunction,
  Layer,
  Option,
  Result,
  Schema,
} from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { asRunFailed, type RunHook } from "../loop/run.ts";
import { scriptSteps } from "../shell/script-text.ts";
import { ToolFailed } from "../tools/failure.ts";
import { runTool, type RunTool } from "../tools/run-tool.ts";

/**
 * The command lines a project is run with (its tests, build, lint, type check), kept as one list
 * per project (docs/decisions.md "프로젝트가 이미 가진 명령은 목록 하나에 적는다"). A run's model
 * finds them in the project's own files or by asking its task runner, saves them here, and every
 * later run of the project starts with the list. The app knows no task runner: what a line means
 * is the model's to find out, so a list entry is a note and never a permission.
 */

/** How many commands one project keeps. The whole list is sent with every run. */
export const maxProjectCommands = 40;

/** One line of text of at most `characters`, starting with something written. */
const oneLine = (characters: number) =>
  Schema.String.check(Schema.isPattern(/^\S[^\n\r]*$/), Schema.isMaxLength(characters));

export const ProjectCommand = Schema.Struct({
  command: oneLine(200).annotate({
    description:
      'One command line as run from the project root, for example "pnpm test" or "cd packages/api && cargo test".',
  }),
  purpose: oneLine(120).annotate({
    description: 'What the command is for, in a few words, for example "unit tests of the API".',
  }),
});
export type ProjectCommand = typeof ProjectCommand.Type;

export const SaveProjectCommandsInput = Schema.Struct({
  commands: Schema.optionalKey(
    Schema.Array(ProjectCommand).check(Schema.isMaxLength(maxProjectCommands)).annotate({
      description:
        "Command lines to put on the list. One that is already listed gets the purpose given here.",
    }),
  ),
  remove: Schema.optionalKey(
    Schema.Array(Schema.String).check(Schema.isMaxLength(maxProjectCommands)).annotate({
      description:
        "Listed command lines to take off the list, written exactly as listed: ones the project no longer has or that no longer work.",
    }),
  ),
});

export const saveProjectCommandsSpec = {
  name: "save_project_commands",
  description: `Keep the command lines this project is run with (its tests, build, lint, type check, code generation) on the project's command list, which every later conversation of the project starts with. Save a command once you know it is how this project does the job: from AGENTS.md, a CI file, the package scripts, the task runner's own listing, or from having run it. Take off a listed command that failed because the project changed, and put on the one that replaced it. The list holds at most ${maxProjectCommands} commands, so keep the ones worth running again, not every variation of one. A listed command is a note, not a permission: it still runs through run_command. Returns the list as it is now.`,
  parameters: SaveProjectCommandsInput,
} as const;

/** The list as every run of the project reads it, after the system prompts before it. */
const commandsPrompt = (commands: ReadonlyArray<ProjectCommand>) =>
  [
    "[Project commands]",
    "Command lines this project is run with, kept from earlier conversations with save_project_commands. Run one with run_command from the project root instead of working the command out again. They are notes and do not grant permissions. One may be out of date: when it fails because the project changed, find the command that replaced it and correct the list.",
    ...commands.map(({ command, purpose }) => `- ${JSON.stringify(command)}: ${purpose}`),
  ].join("\n");

/**
 * A script that only runs commands the list already holds, as the start of what its refusal says.
 * A step counts when it starts with a listed command, so arguments after it change nothing.
 */
export const listedCoverage: {
  (commands: ReadonlyArray<ProjectCommand>): (script: string) => Option.Option<string>;
  (script: string, commands: ReadonlyArray<ProjectCommand>): Option.Option<string>;
} = EffectFunction.dual(2, listedCoverageBody);
function listedCoverageBody(
  script: string,
  commands: ReadonlyArray<ProjectCommand>,
): Option.Option<string> {
  const listed = Arr.dedupe(
    commands.flatMap(({ command }) => scriptSteps(command).map(({ text }) => text)),
  );
  const covering = scriptSteps(script).map(({ text }) =>
    Arr.findFirst(listed, (line) => text === line || text.startsWith(`${line} `)),
  );
  return covering.length > 0 && covering.every(Option.isSome)
    ? Option.some(
        `Every step of the script is a command of the project's command list (${Arr.dedupe(
          Arr.getSomes(covering),
        )
          .map((line) => JSON.stringify(line))
          .join(", ")}).`,
      )
    : Option.none();
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const listed = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ command: Schema.String, purpose: Schema.String }),
    execute: (projectId) => sql`
      SELECT command, purpose FROM project_commands
      WHERE project_id = ${projectId} ORDER BY rowid`,
  });
  const removed = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: Schema.String, command: Schema.String }),
    Result: Schema.Struct({ command: Schema.String }),
    execute: ({ projectId, command }) => sql`
      DELETE FROM project_commands
      WHERE project_id = ${projectId} AND command = ${command} RETURNING command`,
  });
  const isoNow = Effect.map(Clock.currentTimeMillis, (millis) =>
    DateTime.formatIso(DateTime.makeUnsafe(millis)),
  );

  /** The project's commands, in the order they were first saved. */
  const list = (projectId: string) => listed(projectId);

  /**
   * Takes `remove` off the list and puts `commands` on it, as one change: a list that would hold
   * more than {@link maxProjectCommands} is refused and nothing changes. Gives the list as it is
   * afterwards, and the lines of `remove` that were not on it.
   */
  const change = Effect.fn("ProjectCommands.change")(function* (
    projectId: string,
    { commands = [], remove = [] }: typeof SaveProjectCommandsInput.Type,
  ) {
    const savedAt = yield* isoNow;
    const taken = yield* Effect.forEach(Arr.dedupe(remove.map((line) => line.trim())), (command) =>
      Effect.map(removed({ projectId, command }), (rows) => ({ command, found: rows.length > 0 })),
    );
    yield* Effect.forEach(
      commands,
      ({ command, purpose }) => sql`
        INSERT INTO project_commands (project_id, command, purpose, saved_at)
        VALUES (${projectId}, ${command.trim()}, ${purpose.trim()}, ${savedAt})
        ON CONFLICT(project_id, command) DO UPDATE
          SET purpose = excluded.purpose, saved_at = excluded.saved_at`,
      { discard: true },
    );
    const now = yield* list(projectId);
    yield* Effect.when(
      Effect.fail(
        ToolFailed.make({
          code: "too_many_commands",
          tag: "ProjectCommandsFull",
          detail: `The list would hold ${now.length} commands and holds at most ${maxProjectCommands}. In the same call, take off with remove the ones least worth running again. Nothing was changed.`,
          refused: true,
        }),
      ),
      Effect.succeed(now.length > maxProjectCommands),
    );
    const notListed = Arr.filterMap(taken, ({ command, found }) =>
      found ? Result.failVoid : Result.succeed(command),
    );
    return notListed.length === 0 ? { commands: now } : { commands: now, notListed };
  }, sql.withTransaction);

  return {
    list,
    change,

    /**
     * The command list, read once as the run starts and sent after the system prompts the hooks
     * before this one chose. A change the run itself saves shows in the next run, so the run's
     * prompt stays the same from its first request to its last. A project without commands gets
     * no prompt.
     */
    hookFor: Effect.fnUntraced(function* (projectId: string) {
      const prompt = yield* Effect.cached(
        list(projectId).pipe(
          Effect.map((commands) => (commands.length === 0 ? [] : [commandsPrompt(commands)])),
          Effect.mapError(asRunFailed),
        ),
      );
      return {
        request: (_scope, request) =>
          Effect.map(prompt, (added) => ({ ...request, system: [...request.system, ...added] })),
      } satisfies RunHook;
    }),

    /** The run's `save_project_commands` tool. A failure of the store names no statement. */
    toolFor: (projectId: string): RunTool =>
      runTool({
        ...saveProjectCommandsSpec,
        handler: (input) =>
          change(projectId, input).pipe(
            Effect.catchTags({
              SqlError: (error) =>
                Effect.fail(
                  ToolFailed.make({
                    code: "project_commands_store_failed",
                    tag: error._tag,
                    detail: "The command list could not be saved; try again or tell the user.",
                  }),
                ),
              SchemaError: (error) =>
                Effect.fail(
                  ToolFailed.make({
                    code: "project_commands_store_failed",
                    tag: error._tag,
                    detail: "The command list could not be read back; try again or tell the user.",
                  }),
                ),
            }),
          ),
      }),
  };
});

/** Each project's command list. Reads and writes go through the owner's own `SqlClient`. */
export class ProjectCommands extends Context.Service<
  ProjectCommands,
  Effect.Success<typeof make>
>()("memory-agent/projects/commands/ProjectCommands") {
  static readonly layer = Layer.effect(ProjectCommands, make);
}
