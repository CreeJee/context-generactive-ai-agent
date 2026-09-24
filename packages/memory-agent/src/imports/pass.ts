import { statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { Cause, Context, Effect, Layer, Schema } from "effect";
import { GlobalConfig } from "../config/global-config.ts";
import { StorageRoot } from "../config/storage-root.ts";
import { Database } from "../db/database.ts";
import { canonicalPath } from "../files/paths.ts";
import { Projects } from "../projects/projects.ts";
import { SecretRedactor, type SecretRedactionFailed } from "../secrets/redactor.ts";
import { Sessions } from "../sessions/sessions.ts";
import { BulkNodes } from "./bulk.ts";
import type { ImportSourceName, TranscriptItem, TranscriptStart } from "./items.ts";
import { readLinesFrom } from "./lines.ts";
import { findTranscripts, importSources, type Transcript } from "./sources.ts";

/** How long a conversation's title may be; the session list shows one line. */
const titleLength = 60;
/** How much of a failure settings shows; the rest adds nothing to "this file could not be read". */
const failureLength = 300;
/**
 * Items written per transaction. The pass runs in a worker with its own connection, and while it
 * holds the write lock the server's own writes wait on its main thread, so a long transcript is
 * written in pieces.
 */
const writeChunk = 200;

/** Where a pass stands: transcripts looked at of those found, nodes written, transcripts failed. */
export interface PassProgress {
  readonly checked: number;
  readonly total: number;
  readonly written: number;
  readonly failed: number;
}

/** How many transcripts each source has on disk. */
export type TranscriptCounts = ReadonlyArray<{
  readonly source: ImportSourceName;
  readonly transcripts: number;
}>;

const decodeCursor = Schema.decodeUnknownSync(
  Schema.Struct({ byte_offset: Schema.Number, size: Schema.Number, mtime_ms: Schema.Number }),
);
const decodeSessionId = Schema.decodeUnknownSync(Schema.Struct({ session_id: Schema.String }));

/** What settings says went wrong: the error's message, never the transcript's content. */
const failureOf = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  const reason = error instanceof Error ? error.message || error.name : String(error);
  return reason.slice(0, failureLength);
};

/** True when `candidate` is `root` or below it. Compared by spelling: a recorded cwd may be gone. */
function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

const firstLine = (text: string) => text.replace(/\s+/gu, " ").trim().slice(0, titleLength);

const make = (home: string) =>
  Effect.gen(function* () {
    const { sqlite, atomic } = yield* Database;
    const storage = yield* StorageRoot;
    const projects = yield* Projects;
    const sessions = yield* Sessions;
    const bulk = yield* BulkNodes;
    const config = yield* GlobalConfig;
    const redactor = yield* SecretRedactor;
    const storageRoot = canonicalPath(storage.path);

    const hideText = (text: string) =>
      Effect.map(redactor.redactText(text), (redaction) => redaction.text);

    /** An item as memory may keep it: its text and the files or URLs it names, secrets hidden. */
    const hideSecrets = (
      item: TranscriptItem,
    ): Effect.Effect<TranscriptItem, SecretRedactionFailed> => {
      switch (item.kind) {
        case "session":
        case "ignored":
          return Effect.succeed(item);
        case "message":
        case "tool_result":
          return Effect.map(hideText(item.text), (text) => ({ ...item, text }));
        case "tool_call":
          return Effect.map(
            Effect.all([hideText(item.text), Effect.forEach(item.refs, hideText)]),
            ([text, refs]) => ({ ...item, text, refs }),
          );
      }
    };

    const readCursor = sqlite.prepare(
      "SELECT byte_offset, size, mtime_ms FROM import_cursors WHERE source = ? AND path = ?",
    );
    const saveCursor = sqlite.prepare(`
      INSERT INTO import_cursors (source, path, external_id, cwd, byte_offset, size, mtime_ms, imported, skipped, failure, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT (source, path) DO UPDATE SET external_id = excluded.external_id,
        cwd = coalesce(excluded.cwd, import_cursors.cwd), byte_offset = excluded.byte_offset,
        size = excluded.size, mtime_ms = excluded.mtime_ms,
        imported = import_cursors.imported + excluded.imported, skipped = excluded.skipped,
        failure = NULL, updated_at = excluded.updated_at`);
    // Keeps how far the transcript was read and what it wrote; size -1 makes the next pass retry it.
    const saveFailure = sqlite.prepare(`
      INSERT INTO import_cursors (source, path, external_id, size, mtime_ms, failure, updated_at)
      VALUES (?, ?, ?, -1, 0, ?, ?)
      ON CONFLICT (source, path) DO UPDATE SET size = -1, skipped = NULL,
        failure = excluded.failure, updated_at = excluded.updated_at`);
    const readMapping = sqlite.prepare(
      "SELECT session_id FROM imported_sessions WHERE source = ? AND external_id = ?",
    );
    const saveMapping = sqlite.prepare(
      "INSERT INTO imported_sessions (source, external_id, session_id) VALUES (?, ?, ?)",
    );
    const nameSession = sqlite.prepare(
      "UPDATE sessions SET title = ? WHERE id = ? AND title IS NULL",
    );

    /** Records why a transcript failed, so the pass can go on with the rest. */
    const recordFailure = (transcript: Transcript, cause: Cause.Cause<unknown>) =>
      Effect.sync(() => {
        saveFailure.run(
          transcript.source,
          transcript.path,
          transcript.externalId,
          failureOf(cause),
          new Date().toISOString(),
        );
      });

    /**
     * The project a recorded working directory belongs to, registering the folder when none does.
     * The deepest registered root wins, and hidden projects count: they still own their memory, so
     * a transcript from that folder belongs to them rather than to a second registration.
     *
     * Registering widens what the file and shell tools may touch. The user asked for this, because
     * these are their own working folders and naming them one by one is the tedious part; the
     * project list can be tidied afterwards (`Projects.setHidden`).
     */
    const projectOf = (cwd: string) =>
      Effect.gen(function* () {
        const canonical = canonicalPath(cwd);
        const registered = yield* projects.listAll;
        const owner = registered
          .filter((project) => isWithin(project.root, canonical))
          .sort((a, b) => b.root.length - a.root.length)
          .at(0);
        if (owner) return { project: owner, rejected: null };
        // A folder that has been deleted, or one inside this app's own storage, is left alone.
        return yield* projects.add(canonical).pipe(
          Effect.map((project) => ({ project, rejected: null })),
          Effect.catchTag("ProjectRootRejected", (rejection) =>
            Effect.succeed({ project: null, rejected: rejection.reason }),
          ),
        );
      });

    /**
     * The session a transcript writes into, creating it the first time the transcript is read.
     * `null` with a reason means the transcript cannot be placed, and the reason is what the
     * settings screen shows for that folder.
     */
    const sessionFor = (transcript: Transcript, start: TranscriptStart | undefined) =>
      Effect.gen(function* () {
        const existing = readMapping.get(transcript.source, transcript.externalId);
        if (existing) return { sessionId: decodeSessionId(existing).session_id, skipped: null };
        if (!start) return { sessionId: null, skipped: "no_session_line" };
        const { project, rejected } = yield* projectOf(start.cwd);
        if (!project) return { sessionId: null, skipped: rejected ?? "no_project" };
        const session = yield* sessions.createImported(
          project.id,
          null,
          start.startedAt,
          transcript.source,
        );
        saveMapping.run(transcript.source, transcript.externalId, session.id);
        return { sessionId: session.id, skipped: null };
      });

    /** Reads what is new in one transcript. Returns how many nodes it wrote. */
    const migrate = (transcript: Transcript, interpret: boolean) =>
      Effect.gen(function* () {
        const stats = yield* Effect.try(() => statSync(transcript.path)).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (!stats) return 0;
        const saved = readCursor.get(transcript.source, transcript.path);
        const cursor = saved ? decodeCursor(saved) : null;
        if (cursor && cursor.size === stats.size && cursor.mtime_ms === stats.mtimeMs) return 0;
        // A file shorter than the cursor was rewritten or truncated; reading it again is safe
        // because `imported_nodes` drops every line that already became a node.
        const from = cursor && stats.size >= cursor.size ? cursor.byte_offset : 0;

        const source = importSources.find((entry) => entry.name === transcript.source);
        if (!source) return 0;
        const read = source.reader(transcript.externalId);
        const lines: TranscriptItem[] = [];
        const { offset } = readLinesFrom(transcript.path, from, (line) => {
          for (const item of read(line)) lines.push(item);
        });
        // Another agent's transcript holds whatever its shell printed; memory keeps none of it.
        const items = yield* Effect.forEach(lines, hideSecrets);

        const start = items.find((item) => item.kind === "session");
        const { sessionId, skipped } = yield* sessionFor(transcript, start);
        const now = new Date().toISOString();
        if (!sessionId) {
          // Leave the offset at 0: if the folder comes back, the whole transcript is read.
          saveCursor.run(
            transcript.source,
            transcript.path,
            transcript.externalId,
            start?.cwd ?? null,
            0,
            stats.size,
            stats.mtimeMs,
            0,
            skipped,
            now,
          );
          return 0;
        }

        const session = yield* sessions.get(sessionId);
        let written = 0;
        for (let index = 0; index < items.length; index += writeChunk) {
          written += bulk.write({
            source: transcript.source,
            projectId: session.projectId,
            sessionId,
            items: items.slice(index, index + writeChunk),
            interpret,
          }).written;
          // Lets other work in the worker (a count for settings) in between pieces.
          yield* Effect.yieldNow();
        }
        // A conversation is named by what the person opened it with.
        if (session.title === null) {
          const opening = items.find((item) => item.kind === "message" && item.role === "user");
          if (opening?.kind === "message")
            atomic(() => nameSession.run(firstLine(opening.text), sessionId));
        }
        saveCursor.run(
          transcript.source,
          transcript.path,
          transcript.externalId,
          start?.cwd ?? null,
          offset,
          stats.size,
          stats.mtimeMs,
          written,
          null,
          now,
        );
        return written;
      });

    /** Transcripts of every source, minus anything inside this app's own storage. */
    const transcripts = () =>
      findTranscripts(home).filter(
        (transcript) => !isWithin(storageRoot, canonicalPath(transcript.path)),
      );

    const countsOf = (found: readonly Transcript[]): TranscriptCounts =>
      importSources.map((source) => ({
        source: source.name,
        transcripts: found.filter((transcript) => transcript.source === source.name).length,
      }));

    return {
      counts: Effect.sync(() => countsOf(transcripts())),

      /**
       * Reads what is new in every transcript. A file that cannot be read, or a line that cannot be
       * written, fails that transcript alone: it is recorded and tried again on the next pass.
       */
      run: (onProgress: (progress: PassProgress) => void) =>
        Effect.gen(function* () {
          const settings = yield* config.read;
          const interpret = settings.importsInterpret ?? true;
          const found = transcripts();
          let progress: PassProgress = { checked: 0, total: found.length, written: 0, failed: 0 };
          onProgress(progress);
          for (const transcript of found) {
            const outcome = yield* migrate(transcript, interpret).pipe(
              Effect.map((written) => ({ written, failed: 0 })),
              Effect.catchAllCause((cause) =>
                Cause.isInterruptedOnly(cause)
                  ? Effect.failCause(cause)
                  : Effect.as(recordFailure(transcript, cause), { written: 0, failed: 1 }),
              ),
            );
            progress = {
              checked: progress.checked + 1,
              total: progress.total,
              written: progress.written + outcome.written,
              failed: progress.failed + outcome.failed,
            };
            onProgress(progress);
          }
          return { progress, counts: countsOf(found) };
        }),
    };
  });

/**
 * One pass over other coding agents' transcripts: what the import worker runs. It needs only the
 * database and the services that write to it, so the worker opens its own connection.
 */
export class TranscriptPass extends Context.Tag("memory-agent/TranscriptPass")<
  TranscriptPass,
  Effect.Effect.Success<ReturnType<typeof make>>
>() {
  static readonly layer = (home: string) => Layer.effect(TranscriptPass, make(home));
}
