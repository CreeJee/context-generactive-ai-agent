/**
 * One import pass as the CLI runs it: the pass itself, then the indexing that makes what it wrote
 * findable. The command in `./commands.ts` provides the writable storage around this and prints
 * the result; the services here are the ones that assembly brings up.
 */
import { Console, Duration, Effect, Fiber, Schedule } from "effect";
import { GlobalConfig } from "../config/global-config.ts";
import { Importer } from "../imports/importer.ts";
import { Indexer } from "../memory/embedding/indexer.ts";

/** Progress of a running pass, printed on stderr so stdout stays one JSON line. */
const passLine = (progress: {
  readonly checked: number;
  readonly total: number;
  readonly written: number;
  readonly failed: number;
}) =>
  `importing ${progress.checked}/${progress.total} transcripts, ${progress.written} written, ${progress.failed} failed`;

/**
 * Follows the running pass on stderr until the fibre is interrupted. The counts come from the
 * importer's own activity, and a line is printed only when it says something new.
 */
const followPass = Effect.gen(function* () {
  const importer = yield* Importer;
  let last = "";
  return yield* Effect.gen(function* () {
    const overview = yield* importer.overview;
    const activity = overview.activity;
    if (activity === null || activity._tag !== "running") return;
    const line = passLine(activity);
    if (line === last) return;
    last = line;
    yield* Console.error(line);
  }).pipe(
    // The pass owns the outcome; a failed peek at its progress must not end the import.
    Effect.ignore,
    Effect.repeat(Schedule.spaced(Duration.seconds(1))),
  );
});

/**
 * Embeds and indexes what the pass wrote. The import has already succeeded when this runs, so a
 * missing model or a failed download leaves a backlog and its reason in the result instead of
 * failing the command.
 */
const drainIndex = Effect.gen(function* () {
  const indexer = yield* Indexer;
  const reason = yield* Effect.all([indexer.lexicalAll(), indexer.indexAll()], {
    discard: true,
  }).pipe(
    Effect.as<string | null>(null),
    Effect.catchCause((cause) => Effect.succeed(String(cause))),
  );
  return { skipped: false, reason, unindexed: yield* indexer.pending };
});

/**
 * Runs the pass over the storage the services were built on.
 *
 * Interpretation is a model call the CLI has no login for, so the setting this run needs is put in
 * place and the previous value is restored when the caller's scope closes.
 */
export const runImportPass = Effect.fnUntraced(function* (options: {
  readonly storage: string;
  readonly interpret: boolean;
  readonly noIndex: boolean;
}) {
  const importer = yield* Importer;
  const indexer = yield* Indexer;
  const config = yield* GlobalConfig;
  const before = (yield* config.read).importsInterpret;
  yield* Effect.acquireRelease(config.update({ importsInterpret: options.interpret }), () =>
    before === undefined
      ? Effect.void
      : config.update({ importsInterpret: before }).pipe(Effect.ignore),
  );
  yield* Console.error(`importing into ${options.storage}`);
  const progress = yield* Effect.forkChild(followPass);
  yield* importer.runOnce.pipe(Effect.ensuring(Fiber.interrupt(progress)));
  const indexed = options.noIndex
    ? { skipped: true, reason: null, unindexed: yield* indexer.pending }
    : yield* drainIndex;
  const overview = yield* importer.overview;
  const activity = overview.activity;
  return {
    storage: options.storage,
    pass:
      activity === null || activity._tag !== "finished"
        ? null
        : {
            checked: activity.checked,
            total: activity.total,
            written: activity.written,
            failed: activity.failed,
          },
    interpret: overview.interpret,
    indexed,
    sources: overview.sources,
    unplaced: overview.unplaced,
    failures: overview.failures,
  };
});
