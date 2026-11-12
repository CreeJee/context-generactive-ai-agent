import process from "node:process";
import { Argument, Command, Flag } from "effect/cli";
import { Console, Config, Effect, Option, Schema } from "effect";
import { Projects } from "../projects/projects.ts";
import { CliFailure, resolveProjectId } from "./project-reference.ts";
import { readStructuredEvidence, traceStructuredEvidence } from "../memory/evidence.ts";
import { MemorySearch } from "../memory/search.ts";
import { readOnlyMemoryLayer } from "./read-only-storage.ts";
import { importStatus } from "./import-status.ts";
import { writableMemoryLayer } from "./writable-storage.ts";
import { runImportPass } from "./import-run.ts";
import { compactStorage } from "./compact.ts";
import { nodePlatformLayer } from "../runtime/node-platform.ts";
import { defaultStorageRoot } from "../config/storage-root.ts";

/**
 * The memory commands, shared by both entry points: the standalone `bin/context-agent-cli.ts`
 * and the executable's `context-agent memory …`. Every command reads one storage folder
 * read-only and prints one JSON line.
 */

/** What a refusal says about itself: short strings the caller can act on, never memory text. */
type RefusalDetail = Readonly<Record<string, string | null>>;

/** The command output contract: one JSON line, encoded through the schema codec. */
const jsonLine = Schema.fromJsonString(Schema.Unknown);

const encodeLine = <A>(value: A) => Schema.encodeEffect(jsonLine)(value).pipe(Effect.orDie);

/** One JSON line on stdout, the command's whole output contract. */
const print = <A>(value: A) => Effect.flatMap(encodeLine(value), Console.log);

/** `--storage`, else `$CONTEXT_AGENT_HOME`, else the default storage root. */
export const resolveStorage = (given: Option.Option<string>) =>
  Option.match(given, {
    onSome: (value) => Effect.succeed(value),
    onNone: () =>
      Effect.flatMap(defaultStorageRoot, (fallback) =>
        Config.String("CONTEXT_AGENT_HOME").pipe(Config.withDefault(fallback)),
      ),
  });

/**
 * The `--storage` value the memory commands would parse out of raw arguments, before effect/cli
 * runs: the executable's entry must know the storage root to unpack the runtime into before it can
 * start the CLI. It reads the same token forms effect/cli's lexer and parser do (`--storage <value>`
 * and `--storage=<value>`, nothing after `--`) and keeps the first occurrence, as a second one fails
 * the command's parse anyway. What would parse as the flag's value stays in sync with the parser:
 * a token that is itself an option leaves the flag valueless, which the CLI then reports.
 */
export const storageFlagValue = (args: ReadonlyArray<string>): Option.Option<string> => {
  const at = args.indexOf("--");
  const tokens = at === -1 ? args : args.slice(0, at);
  for (const [index, token] of tokens.entries()) {
    if (token === "--storage") {
      const value = tokens[index + 1];
      if (value !== undefined && !value.startsWith("-")) return Option.some(value);
      return Option.none();
    }
    if (token.startsWith("--storage=")) return Option.some(token.slice("--storage=".length));
  }
  return Option.none();
};

/** The storage root the memory commands over these raw arguments would read and write. */
export const resolveStorageRoot = (args: ReadonlyArray<string>) =>
  resolveStorage(storageFlagValue(args));

/** The project flags plus the working directory the command was started in. */
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
const selection = (projectId: Option.Option<string>, project: Option.Option<string>) => ({
  projectId,
  project,
  cwd: process.cwd(),
});

const storageFlag = Flag.String("storage").pipe(
  Flag.withDescription(
    "storage folder to read (default: $CONTEXT_AGENT_HOME or ~/.context-generactive-agent)",
  ),
  Flag.optional,
);

const projectIdFlag = Flag.String("project-id").pipe(
  Flag.withDescription("exact id of the project to read from"),
  Flag.optional,
);

const projectFlag = Flag.String("project").pipe(
  Flag.withDescription(
    "project to read from: its root path (or a folder inside it) or its name; default is the working directory's project",
  ),
  Flag.optional,
);

const thisProjectOnlyFlag = Flag.Boolean("this-project-only").pipe(
  Flag.withDescription("search only the resolved project instead of every allowed project"),
  Flag.withDefault(false),
);

const findMemory = Command.make(
  "find-memory",
  {
    query: Argument.String("query").pipe(Argument.withDescription("what to look up in memory")),
    projectId: projectIdFlag,
    project: projectFlag,
    thisProjectOnly: thisProjectOnlyFlag,
    limit: Flag.Int("limit").pipe(Flag.withDescription("matches to return"), Flag.withDefault(12)),
    storage: storageFlag,
  },
  ({ limit, project, projectId, query, storage, thisProjectOnly }) =>
    Effect.gen(function* () {
      const root = yield* resolveStorage(storage);
      const result = yield* Effect.gen(function* () {
        const resolved = yield* resolveProjectId(selection(projectId, project));
        const search = yield* MemorySearch;
        return yield* search.find({
          query,
          projectId: resolved,
          crossProject: !thisProjectOnly,
          limit,
        });
      }).pipe(
        // A command handler is its own composition root: the read-only layer is built per
        // invocation over --storage and torn down with the command.
        // @effect-diagnostics-next-line strictEffectProvide:off
        Effect.provide(readOnlyMemoryLayer({ storage: root })),
      );
      yield* print(result);
    }),
).pipe(Command.withDescription("search stored memory as find_memory does"));

const readEvidence = Command.make(
  "read-evidence",
  {
    id: Argument.String("id").pipe(
      Argument.withDescription("node id to read, as find-memory returned it"),
    ),
    offset: Flag.Int("offset").pipe(
      Flag.withDescription(
        "UTF-16 offset to read from; a match's matchedSpan.start resumes a node",
      ),
      Flag.withDefault(0),
    ),
    projectId: projectIdFlag,
    project: projectFlag,
    thisProjectOnly: thisProjectOnlyFlag,
    storage: storageFlag,
  },
  ({ id, offset, project, projectId, storage, thisProjectOnly }) =>
    Effect.gen(function* () {
      const root = yield* resolveStorage(storage);
      const page = yield* Effect.gen(function* () {
        const resolved = yield* resolveProjectId(selection(projectId, project));
        return yield* readStructuredEvidence(id, offset, resolved, !thisProjectOnly);
      }).pipe(
        // @effect-diagnostics-next-line strictEffectProvide:off
        Effect.provide(readOnlyMemoryLayer({ storage: root })),
      );
      if (page === null) {
        return yield* CliFailure.make({ code: "node_not_found", detail: { id } });
      }
      yield* print(page);
    }),
).pipe(Command.withDescription("read a node's original text with its provenance and changes"));

const traceEvidence = Command.make(
  "trace-evidence",
  {
    id: Argument.String("id").pipe(
      Argument.withDescription("node id to trace, as find-memory returned it"),
    ),
    projectId: projectIdFlag,
    project: projectFlag,
    thisProjectOnly: thisProjectOnlyFlag,
    storage: storageFlag,
  },
  ({ id, project, projectId, storage, thisProjectOnly }) =>
    Effect.gen(function* () {
      const root = yield* resolveStorage(storage);
      const trace = yield* Effect.gen(function* () {
        const resolved = yield* resolveProjectId(selection(projectId, project));
        return yield* traceStructuredEvidence(id, resolved, !thisProjectOnly);
      }).pipe(
        // @effect-diagnostics-next-line strictEffectProvide:off
        Effect.provide(readOnlyMemoryLayer({ storage: root })),
      );
      if (trace === null) {
        return yield* CliFailure.make({ code: "node_not_found", detail: { id } });
      }
      yield* print(trace);
    }),
).pipe(Command.withDescription("trace a statement back to the user turn that caused it"));

const listProjects = Command.make("projects", { storage: storageFlag }, ({ storage }) =>
  Effect.gen(function* () {
    const root = yield* resolveStorage(storage);
    const projects = yield* Effect.gen(function* () {
      const service = yield* Projects;
      return yield* service.listAll;
    }).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(readOnlyMemoryLayer({ storage: root })),
    );
    yield* print(
      projects.map((project) => ({
        id: project.id,
        name: project.name,
        root: project.root,
        hidden: project.hiddenAt !== null,
        crossRecallExcluded: project.crossRecallExcluded,
      })),
    );
  }),
).pipe(
  Command.withDescription("list the storage's projects, so a caller can name one by id or root"),
);

const importChats = Command.make(
  "import",
  {
    interpret: Flag.Boolean("interpret").pipe(
      Flag.withDescription(
        "queue the imported conversations for interpretation, which the app does later with a provider login (default: off)",
      ),
      Flag.withDefault(false),
    ),
    noIndex: Flag.Boolean("no-index").pipe(
      Flag.withDescription(
        "import without embedding and indexing; find-memory reaches the conversations only after a later run indexes them",
      ),
      Flag.withDefault(false),
    ),
    importsHome: Flag.String("imports-home").pipe(
      Flag.withDescription(
        "home directory holding the other agents' transcripts (.claude, .codex); default is the user's home",
      ),
      Flag.optional,
    ),
    storage: storageFlag,
  },
  ({ importsHome, interpret, noIndex, storage }) =>
    Effect.gen(function* () {
      const root = yield* resolveStorage(storage);
      const result = yield* runImportPass({ storage: root, interpret, noIndex }).pipe(
        Effect.scoped,
        // A command handler is its own composition root: the writable layer takes the storage
        // lock for this invocation and gives it back with the command.
        // @effect-diagnostics-next-line strictEffectProvide:off
        Effect.provide(
          writableMemoryLayer({
            storage: root,
            importsHome: Option.getOrUndefined(importsHome),
          }),
        ),
      );
      yield* print(result);
    }),
).pipe(
  Command.withDescription(
    "import other coding agents' conversations (Claude Code, Codex) into memory and index them",
  ),
);

const importStatusCommand = Command.make(
  "import-status",
  {
    importsHome: Flag.String("imports-home").pipe(
      Flag.withDescription(
        "home directory holding the other agents' transcripts (.claude, .codex)",
      ),
      Flag.optional,
    ),
    storage: storageFlag,
  },
  ({ importsHome, storage }) =>
    Effect.gen(function* () {
      const root = yield* resolveStorage(storage);
      const status = yield* importStatus({
        storage: root,
        importsHome: Option.getOrUndefined(importsHome),
      }).pipe(
        // Read-only: no lock, so this answers while the app owns the storage folder.
        // @effect-diagnostics-next-line strictEffectProvide:off
        Effect.provide(readOnlyMemoryLayer({ storage: root })),
      );
      yield* print(status);
    }),
).pipe(
  Command.withDescription("show what the import has taken in so far, without taking the lock"),
);

const compactCommand = Command.make("compact", { storage: storageFlag }, ({ storage }) =>
  Effect.gen(function* () {
    const root = yield* resolveStorage(storage);
    const result = yield* compactStorage(root).pipe(
      Effect.scoped,
      // A command handler is its own composition root, as `import` is.
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(nodePlatformLayer),
    );
    yield* print(result);
  }),
).pipe(
  Command.withDescription(
    "shrink the database file by rewriting it without its free pages; close the app first. It takes about a minute for every 6 GB and needs free disk space up to twice the file's size",
  ),
);

/**
 * The commands under one parent, named for the entry point that runs them: `memory` inside the
 * executable, the bin's own name standalone.
 */
export const memoryCommands = (name: string) =>
  Command.make(name).pipe(
    Command.withDescription("context-agent's memory without the app"),
    Command.withSubcommands([
      findMemory,
      readEvidence,
      traceEvidence,
      listProjects,
      importChats,
      importStatusCommand,
      compactCommand,
    ]),
  );

/** A refusal prints one JSON line on stderr and leaves exit status 2. */
const refuse = (code: string, detail: RefusalDetail) =>
  Effect.gen(function* () {
    yield* Effect.flatMap(encodeLine({ error: { code, detail } }), Console.error);
    // Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
    yield* Effect.sync(() => {
      process.exitCode = 2;
    });
  });

/**
 * Runs the memory commands over already-parsed arguments, so the caller decides where they came
 * from. Every refusal, expected or not, leaves one JSON line on stderr and exit status 2.
 */
export const runMemoryCli = (options: {
  readonly name: string;
  readonly args: ReadonlyArray<string>;
}) =>
  Command.runWith(memoryCommands(options.name), { version: "0.1.0" })(options.args).pipe(
    Effect.catchTags({
      CliFailure: (error) => refuse(error.code, error.detail),
      StorageOpenFailed: (error) => refuse("storage_not_found", { storage: error.storage }),
      DatabaseSchemaRejected: (error) =>
        refuse("storage_schema_unsupported", { message: error.message }),
      // The app (or another CLI) owns this storage folder; the import never takes it from them.
      StorageLockHeld: (error) =>
        refuse("storage_locked", {
          storage: error.storageRoot,
          port: String(error.port),
          instanceId: error.instanceId,
          pid: String(error.pid),
        }),
      StorageLockFailed: (error) =>
        refuse("storage_lock_failed", {
          storage: error.storageRoot,
          cause: String(error.cause),
        }),
      DatabaseOpenError: (error) => refuse("storage_open_failed", { file: error.file }),
      ImportWorkerFailed: (error) => refuse("import_failed", { reason: error.reason }),
    }),
    // Nothing reaches the terminal as an unexplained crash: an unexpected failure or defect still
    // prints one JSON line with its cause.
    Effect.catchCause((cause) => refuse("unexpected", { cause: String(cause) })),
  );
