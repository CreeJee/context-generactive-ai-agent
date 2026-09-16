import { statSync } from "node:fs";
import { homedir } from "node:os";
import { relative, isAbsolute, sep } from "node:path";
import { Context, Effect, Layer, Schedule, Schema } from "effect";
import { GlobalConfig } from "../config/global-config.ts";
import { StorageRoot } from "../config/storage-root.ts";
import { Database } from "../db/database.ts";
import { canonicalPath } from "../files/paths.ts";
import { Indexer } from "../memory/embedding/indexer.ts";
import { Projects } from "../projects/projects.ts";
import { SecretRedactor } from "../secrets/redactor.ts";
import { Sessions } from "../sessions/sessions.ts";
import { BulkNodes } from "./bulk.ts";
import type { ImportSourceName, TranscriptItem, TranscriptStart } from "./items.ts";
import { readLinesFrom } from "./lines.ts";
import { findTranscripts, importSources, type Transcript } from "./sources.ts";

/** How long a conversation's title may be; the session list shows one line. */
const titleLength = 60;
/** Transcripts only grow, and a stat of every file is cheap, so looking often costs nothing. */
const pollEvery = "5 minutes";

/**
 * A working directory whose transcripts could not be migrated. Folders are registered as projects
 * on their own, so what is left here is what registering could not do: `not_found` (the folder is
 * gone), `not_directory`, `overlaps_storage` (inside this app's own storage).
 */
export interface UnplacedFolder {
  readonly cwd: string;
  readonly reason: string;
  readonly transcripts: number;
}

export interface ImportOverview {
  readonly enabled: boolean;
  readonly interpret: boolean;
  readonly sources: readonly {
    readonly name: ImportSourceName;
    readonly root: string;
    readonly transcripts: number;
    readonly migrated: number;
    readonly nodes: number;
  }[];
  /** Folders whose transcripts could not be placed, with why. */
  readonly unplaced: readonly UnplacedFolder[];
  /** Nodes still waiting for the embedding backlog; migrated ones join the queue like any other. */
  readonly unindexed: number;
}

const decodeCursor = Schema.decodeUnknownSync(
  Schema.Struct({ byte_offset: Schema.Number, size: Schema.Number, mtime_ms: Schema.Number }),
);
const decodeSessionId = Schema.decodeUnknownSync(Schema.Struct({ session_id: Schema.String }));
const decodeCount = Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Number }));
const decodeSourceTotals = Schema.decodeUnknownSync(
  Schema.Struct({ migrated: Schema.Number, nodes: Schema.Number }),
);
const decodeSkipped = Schema.decodeUnknownSync(
  Schema.Struct({ cwd: Schema.String, reason: Schema.String, transcripts: Schema.Number }),
);

/** True when `candidate` is `root` or below it. Compared by spelling: a recorded cwd may be gone. */
function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

const firstLine = (text: string) => text.replace(/\s+/gu, " ").trim().slice(0, titleLength);

const make = (watching: boolean, home: string) =>
  Effect.gen(function* () {
    const { sqlite, atomic } = yield* Database;
    const storage = yield* StorageRoot;
    const projects = yield* Projects;
    const sessions = yield* Sessions;
    const bulk = yield* BulkNodes;
    const config = yield* GlobalConfig;
    const indexer = yield* Indexer;
    const redactor = yield* SecretRedactor;
    const storageRoot = canonicalPath(storage.path);
    // Two passes over the same transcripts would import a line twice before either marks it.
    const onePassAtATime = yield* Effect.makeSemaphore(1);
    const oneDrainAtATime = yield* Effect.makeSemaphore(1);

    const hideText = (text: string) =>
      Effect.map(redactor.redactText(text), (redaction) => redaction.text);

    /** An item as memory may keep it: its text and the files or URLs it names, secrets hidden. */
    const hideSecrets = (item: TranscriptItem): Effect.Effect<TranscriptItem> => {
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
      INSERT INTO import_cursors (source, path, external_id, cwd, byte_offset, size, mtime_ms, imported, skipped, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (source, path) DO UPDATE SET external_id = excluded.external_id,
        cwd = coalesce(excluded.cwd, import_cursors.cwd), byte_offset = excluded.byte_offset,
        size = excluded.size, mtime_ms = excluded.mtime_ms,
        imported = import_cursors.imported + excluded.imported, skipped = excluded.skipped,
        updated_at = excluded.updated_at`);
    const readMapping = sqlite.prepare(
      "SELECT session_id FROM imported_sessions WHERE source = ? AND external_id = ?",
    );
    const saveMapping = sqlite.prepare(
      "INSERT INTO imported_sessions (source, external_id, session_id) VALUES (?, ?, ?)",
    );
    const sourceTotals = sqlite.prepare(`
      SELECT count(*) AS migrated, coalesce(sum(imported), 0) AS nodes FROM import_cursors
      WHERE source = ? AND skipped IS NULL`);
    const skippedFolders = sqlite.prepare(`
      SELECT cwd, skipped AS reason, count(*) AS transcripts FROM import_cursors
      WHERE skipped IS NOT NULL AND cwd IS NOT NULL
      GROUP BY cwd, skipped ORDER BY transcripts DESC, cwd`);

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
        const count = bulk.write({
          source: transcript.source,
          projectId: session.projectId,
          sessionId,
          items,
          interpret,
        });
        // A conversation is named by what the person opened it with.
        if (session.title === null) {
          const opening = items.find((item) => item.kind === "message" && item.role === "user");
          if (opening?.kind === "message")
            atomic(() =>
              sqlite
                .prepare("UPDATE sessions SET title = ? WHERE id = ? AND title IS NULL")
                .run(firstLine(opening.text), sessionId),
            );
        }
        saveCursor.run(
          transcript.source,
          transcript.path,
          transcript.externalId,
          start?.cwd ?? null,
          offset,
          stats.size,
          stats.mtimeMs,
          count.written,
          null,
          now,
        );
        return count.written;
      });

    /** Transcripts of every source, minus anything inside this app's own storage. */
    const transcripts = () =>
      findTranscripts(home).filter(
        (transcript) => !isWithin(storageRoot, canonicalPath(transcript.path)),
      );

    const runOnce = Effect.gen(function* () {
      const settings = yield* config.read;
      const interpret = settings.importsInterpret ?? true;
      let written = 0;
      for (const transcript of transcripts())
        written += yield* migrate(transcript, interpret).pipe(Effect.orElseSucceed(() => 0));
      return written;
    }).pipe(onePassAtATime.withPermits(1));

    /**
     * Embeds and analyses what a migration added, taking as long as it takes. The indexer gives up
     * its permit between batches, so a conversation held meanwhile is still indexed first: its
     * nodes are the newest by time, and that is the order pending nodes come out in.
     */
    const backfill = Effect.zipRight(indexer.indexAll(), indexer.analyzeAll()).pipe(
      Effect.catchAllCause(() => Effect.void),
      oneDrainAtATime.withPermits(1),
    );

    const overview = Effect.gen(function* () {
      const settings = yield* config.read;
      const found = transcripts();
      const unindexed = decodeCount(
        sqlite
          .prepare(`
            SELECT count(*) AS count FROM nodes n
            LEFT JOIN node_vectors v ON v.node_seq = n.seq
            WHERE v.node_seq IS NULL AND length(n.text) > 0`)
          .get(),
      ).count;
      return {
        enabled: settings.importsEnabled ?? false,
        interpret: settings.importsInterpret ?? true,
        sources: importSources.map((source) => {
          const totals = decodeSourceTotals(sourceTotals.get(source.name));
          return {
            name: source.name,
            root: source.root(home),
            transcripts: found.filter((entry) => entry.source === source.name).length,
            migrated: totals.migrated,
            nodes: totals.nodes,
          };
        }),
        unplaced: skippedFolders.all().map((row) => decodeSkipped(row)),
        unindexed,
      } satisfies ImportOverview;
    });

    // The backlog is forked into this layer's scope, not the caller's: a request that starts a
    // migration must return as soon as the transcripts are read, and the drain outlives it.
    const layerScope = yield* Effect.scope;

    /** One pass, then the backlog it created; the backlog never holds up the answer to a request. */
    const runAndIndex = Effect.tap(runOnce, (written) =>
      written > 0 ? Effect.forkIn(backfill, layerScope) : Effect.void,
    );

    if (watching)
      yield* Effect.forkScoped(
        Effect.repeat(
          Effect.gen(function* () {
            const settings = yield* config.read;
            if (settings.importsEnabled === true) yield* runAndIndex;
          }).pipe(Effect.catchAllCause(() => Effect.void)),
          Schedule.spaced(pollEvery),
        ),
      );

    return {
      runOnce,
      runAndIndex,
      overview,
      /** Turns migration on or off and, when turning it on, reads what is there now. */
      setEnabled: (enabled: boolean) =>
        Effect.zipRight(
          config.update({ importsEnabled: enabled }),
          enabled ? Effect.asVoid(runAndIndex) : Effect.void,
        ),
      setInterpret: (interpret: boolean) =>
        Effect.asVoid(config.update({ importsInterpret: interpret })),
    };
  });

/**
 * Migrates other coding agents' local transcripts into this app's memory, and keeps following them
 * as they grow. Reads only; the transcripts stay where their tool wrote them.
 */
export class Importer extends Context.Tag("memory-agent/Importer")<
  Importer,
  Effect.Effect.Success<ReturnType<typeof make>>
>() {
  static readonly layer = (watching: boolean = true, home: string = homedir()) =>
    Layer.scoped(Importer, make(watching, home));
}
