import { Semaphore } from "effect";
import { Worker } from "node:worker_threads";
import { Context, Data, Effect, Layer, Schema } from "effect";
import { Database } from "../db/database.ts";
import { Indexer } from "../memory/embedding/indexer.ts";
import { VectorIndex } from "../memory/embedding/vector-index.ts";
import { runtimeWorker } from "../runtime/resources.ts";
import { RedactReply, type RedactRequest } from "./redact-protocol.ts";
import type { Redaction } from "./redactor.ts";

/**
 * Which detector swept a table. Raise it when the rules start finding things they did not, and
 * every table is swept again from the start.
 */
export const sweepVersion = 1;

/** Rows looked at per transaction; redaction runs before it, so the database is held briefly. */
const batchSize = 200;

/** A text column outside `nodes` that can hold what a tool printed or a person pasted. */
interface Column {
  readonly name: string;
  /** Stored as JSON: secrets are hidden in its strings and the structure is kept. */
  readonly json: boolean;
}

/**
 * Where text is kept besides the nodes: the page's saved conversation, approval requests and the
 * arguments reviewed for them, queued messages, and subagent tasks and answers.
 */
const ColumnTable = Schema.Literals([
  "chat_threads",
  "chat_interrupts",
  "permission_reviews",
  "queued_messages",
  "subagents",
  "interpretations",
]);
type ColumnTable = typeof ColumnTable.Type;

const columnTables = {
  chat_threads: [{ name: "messages", json: true }],
  chat_interrupts: [
    { name: "payload", json: true },
    { name: "response", json: true },
  ],
  permission_reviews: [{ name: "input", json: true }],
  queued_messages: [
    { name: "text", json: false },
    { name: "draft", json: false },
  ],
  subagents: [
    { name: "last_task", json: false },
    { name: "last_answer", json: false },
  ],
  interpretations: [{ name: "reason", json: false }],
} as const satisfies Record<ColumnTable, readonly Column[]>;

/** What one sweep covers; nodes and their references need more than a column update. */
type Target =
  | { readonly kind: "nodes" }
  | { readonly kind: "refs" }
  | { readonly kind: "columns"; readonly table: ColumnTable };

const targets: readonly Target[] = [
  { kind: "nodes" },
  { kind: "refs" },
  ...ColumnTable.literals.map((table): Target => ({ kind: "columns", table })),
];

const targetName = (target: Target) => {
  switch (target.kind) {
    case "nodes":
    case "refs":
      return target.kind;
    case "columns":
      return target.table;
  }
};

const Progress = Schema.Struct({
  version: Schema.Number,
  after: Schema.Number,
  done: Schema.Literals([0, 1]),
  hidden: Schema.Number,
});
const decodeProgress = Schema.decodeUnknownSync(Progress);
const decodeNodeRow = Schema.decodeUnknownSync(
  Schema.Struct({ seq: Schema.Number, text: Schema.String }),
);
const decodeRefRow = Schema.decodeUnknownSync(
  Schema.Struct({ row_key: Schema.Number, ref: Schema.String }),
);
const decodeRowKey = Schema.decodeUnknownSync(Schema.Struct({ row_key: Schema.Number }));
const decodeCell = Schema.decodeUnknownSync(Schema.NullOr(Schema.String));
const decodeReply = Schema.decodeUnknownSync(RedactReply);

/** A column value after sweeping; `null` stays `null`. */
interface SweptCell {
  readonly text: string | null;
  readonly hidden: number;
}

/** The redaction worker could not hide secrets in a batch; the sweep resumes there next time. */
export class RedactionFailed extends Data.TaggedError("RedactionFailed")<{
  readonly reason: string;
}> {}

/** Secrets hidden in a batch of texts, one redaction per text in order. */
type Redact = (
  kind: RedactRequest["kind"],
  texts: readonly string[],
) => Effect.Effect<readonly Redaction[], RedactionFailed>;

/**
 * A redaction worker for one sweep, stopped when the sweep ends: a sweep runs once per start, and
 * the checks it needs stay loaded only while it runs.
 */
const redactionWorker = Effect.map(
  Effect.acquireRelease(
    Effect.sync(() => new Worker(runtimeWorker("redact-worker"))),
    (worker) => Effect.promise(() => worker.terminate()),
  ),
  (worker): Redact => {
    let nextId = 1;
    const waiting = new Map<number, (reply: RedactReply) => void>();
    const lost = (reason: string) => {
      for (const [id, answer] of waiting) answer({ id, kind: "failed", reason });
      waiting.clear();
    };
    worker.on("message", (message) => {
      const reply = decodeReply(message);
      const answer = waiting.get(reply.id);
      waiting.delete(reply.id);
      answer?.(reply);
    });
    worker.on("error", (error) => lost(error.message));
    worker.on("exit", () => lost("the redaction worker stopped"));

    return (kind, texts) =>
      Effect.callback((resume) => {
        if (texts.length === 0) return resume(Effect.succeed([]));
        const id = nextId++;
        waiting.set(id, (reply) => {
          switch (reply.kind) {
            case "redacted":
              return resume(Effect.succeed(reply.redactions));
            case "failed":
              return resume(Effect.fail(new RedactionFailed({ reason: reply.reason })));
          }
        });
        worker.postMessage({ id, kind, texts } satisfies RedactRequest);
      });
  },
);

/** One column's cells after sweeping, in order; a `null` cell is not sent and stays `null`. */
const redactCells = (
  redact: Redact,
  kind: RedactRequest["kind"],
  cells: ReadonlyArray<string | null>,
) =>
  Effect.map(
    redact(
      kind,
      cells.filter((cell) => cell !== null),
    ),
    (redactions) => {
      const swept = redactions[Symbol.iterator]();
      return cells.map((cell): SweptCell =>
        cell === null
          ? { text: null, hidden: 0 }
          : (swept.next().value ?? { text: cell, hidden: 0 }),
      );
    },
  );

export interface SweepProgress {
  readonly target: string;
  readonly done: boolean;
  readonly hidden: number;
}

const make = (running: boolean) =>
  Effect.gen(function* () {
    const { sqlite, atomic } = yield* Database;
    const indexer = yield* Indexer;
    const vectors = yield* VectorIndex;
    const onePassAtATime = yield* Semaphore.make(1);

    const readProgress = sqlite.prepare(
      "SELECT version, after, done, hidden FROM secret_sweeps WHERE target = ?",
    );
    const saveProgress = sqlite.prepare(`
      INSERT INTO secret_sweeps (target, version, after, done, hidden, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (target) DO UPDATE SET version = excluded.version, after = excluded.after,
        done = excluded.done, hidden = excluded.hidden, updated_at = excluded.updated_at`);

    /** Where a target's sweep stands; a sweep by an older detector counts as not started. */
    const progressOf = (target: Target) => {
      const row = readProgress.get(targetName(target));
      const saved = row ? decodeProgress(row) : null;
      return saved?.version === sweepVersion ? saved : { after: 0, done: 0, hidden: 0 };
    };

    // Nodes: the text changes under a permit, and what was derived from the old text goes with it.
    const nodeBatch = sqlite.prepare(
      "SELECT seq, text FROM nodes WHERE seq > ? ORDER BY seq LIMIT ?",
    );
    const grant = sqlite.prepare("INSERT INTO secret_sweep_permits VALUES (?)");
    const revoke = sqlite.prepare("DELETE FROM secret_sweep_permits WHERE node_seq = ?");
    const updateText = sqlite.prepare("UPDATE nodes SET text = ? WHERE seq = ?");
    const unindexText = sqlite.prepare(
      "INSERT INTO nodes_fts (nodes_fts, rowid, text) VALUES ('delete', ?, ?)",
    );
    const indexText = sqlite.prepare("INSERT INTO nodes_fts (rowid, text) VALUES (?, ?)");
    const forgetTerms = sqlite.prepare("DELETE FROM nodes_morph WHERE rowid = ?");
    const forgetAnalysis = sqlite.prepare("DELETE FROM node_morphs WHERE node_seq = ?");
    const forgetVector = sqlite.prepare("DELETE FROM node_vectors WHERE node_seq = ?");

    const sweepNodes = (redact: Redact, after: number) =>
      Effect.gen(function* () {
        const rows = nodeBatch.all(after, batchSize).map((row) => decodeNodeRow(row));
        const redactions = yield* redact(
          "text",
          rows.map((row) => row.text),
        );
        const changed = rows.flatMap((row, index) => {
          const redaction = redactions[index];
          return redaction && redaction.hidden > 0 ? [{ ...row, hidden: redaction.text }] : [];
        });
        // Under the indexer's permits, so no batch embeds or analyses a node between the vector
        // being dropped here and its text changing.
        yield* indexer.exclusive(
          Effect.gen(function* () {
            if (changed.length > 0) {
              // Saved before the database commits, as the indexer does: a crash in between leaves
              // the index and the table disagreeing on size, which reopening detects and rebuilds.
              yield* vectors.remove(changed.map((row) => row.seq));
              yield* vectors.save();
            }
            atomic(() => {
              for (const row of changed) {
                grant.run(row.seq);
                unindexText.run(row.seq, row.text);
                updateText.run(row.hidden, row.seq);
                indexText.run(row.seq, row.hidden);
                revoke.run(row.seq);
                forgetTerms.run(row.seq);
                forgetAnalysis.run(row.seq);
                forgetVector.run(row.seq);
              }
            });
          }),
        );
        return { rows: rows.length, last: rows.at(-1)?.seq ?? after, hidden: changed.length };
      });

    // References: a URL a call named. Replacing keeps the row; a clash with an identical, already
    // hidden reference of the same node just leaves that one.
    const refBatch = sqlite.prepare(
      "SELECT rowid AS row_key, ref FROM node_refs WHERE rowid > ? ORDER BY rowid LIMIT ?",
    );
    const updateRef = sqlite.prepare("UPDATE OR REPLACE node_refs SET ref = ? WHERE rowid = ?");

    const sweepRefs = (redact: Redact, after: number) =>
      Effect.gen(function* () {
        const rows = refBatch.all(after, batchSize).map((row) => decodeRefRow(row));
        const redactions = yield* redact(
          "text",
          rows.map((row) => row.ref),
        );
        let hidden = 0;
        atomic(() =>
          rows.forEach((row, index) => {
            const redaction = redactions[index];
            if (!redaction || redaction.hidden === 0) return;
            updateRef.run(redaction.text, row.row_key);
            hidden += 1;
          }),
        );
        return { rows: rows.length, last: rows.at(-1)?.row_key ?? after, hidden };
      });

    const sweepColumns = (redact: Redact, table: ColumnTable, after: number) =>
      Effect.gen(function* () {
        const columns: readonly Column[] = columnTables[table];
        const names = columns.map((column) => column.name);
        // Aliased: a table with an INTEGER PRIMARY KEY returns `rowid` under that column's name.
        const rows = sqlite
          .prepare(
            `SELECT rowid AS row_key, ${names.join(", ")} FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
          )
          .all(after, batchSize);
        const update = sqlite.prepare(
          `UPDATE ${table} SET ${names.map((name) => `${name} = ?`).join(", ")} WHERE rowid = ?`,
        );
        const cells = rows.map((row) => columns.map((column) => decodeCell(row[column.name])));
        // One request per column rather than per cell: `swept[column][row]`.
        const swept = yield* Effect.forEach(columns, (column, index) =>
          redactCells(
            redact,
            column.json ? "json" : "text",
            cells.map((row) => row[index] ?? null),
          ),
        );
        let hidden = 0;
        const updates: Array<{ rowid: number; values: Array<string | null> }> = [];
        rows.forEach((row, rowIndex) => {
          const values = swept.map((column) => column[rowIndex] ?? { text: null, hidden: 0 });
          if (values.every((cell) => cell.hidden === 0)) return;
          hidden += 1;
          updates.push({
            rowid: decodeRowKey(row).row_key,
            values: values.map((cell) => cell.text),
          });
        });
        atomic(() => {
          for (const { rowid, values } of updates) update.run(...values, rowid);
        });
        const last = rows.at(-1);
        return { rows: rows.length, last: last ? decodeRowKey(last).row_key : after, hidden };
      });

    const batchOf = (redact: Redact, target: Target, after: number) => {
      switch (target.kind) {
        case "nodes":
          return sweepNodes(redact, after);
        case "refs":
          return sweepRefs(redact, after);
        case "columns":
          return sweepColumns(redact, target.table, after);
      }
    };

    /**
     * Where a table's sweep starts this time.
     *
     * Nodes and references are only ever added, and what is added now is hidden on the way in, so
     * their sweep carries on from where it stopped — including rows added since, which is how text
     * written by an older build of this app is still caught.
     *
     * The other tables are rewritten in place (a conversation grows inside its one row) and are not
     * all hidden on the way in, so a position means nothing for them: they are read in full on every
     * start. They are small next to the nodes.
     */
    const resumesFrom = (target: Target, saved: number) => {
      switch (target.kind) {
        case "nodes":
        case "refs":
          return saved;
        case "columns":
          return 0;
      }
    };

    /** Sweeps one table to the end, recording where it got after every batch. */
    const sweep = (redact: Redact, target: Target) =>
      Effect.gen(function* () {
        const start = progressOf(target);
        let after = resumesFrom(target, start.after);
        let hidden = start.hidden;
        let sweptNow = 0;
        for (;;) {
          const batch = yield* batchOf(redact, target, after);
          after = batch.last;
          hidden += batch.hidden;
          sweptNow += batch.hidden;
          const finished = batch.rows < batchSize;
          saveProgress.run(
            targetName(target),
            sweepVersion,
            after,
            finished ? 1 : 0,
            hidden,
            new Date().toISOString(),
          );
          if (finished) return sweptNow;
        }
      });

    /**
     * Sweeps what this detector has not seen. Nodes whose text changed are embedded and analysed
     * again afterwards, from the hidden text. Returns how many nodes changed.
     */
    const run = Effect.gen(function* () {
      let changedNodes = 0;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const redact = yield* redactionWorker;
          for (const target of targets) {
            const hidden = yield* sweep(redact, target);
            if (target.kind === "nodes") changedNodes = hidden;
          }
        }),
      );
      if (changedNodes > 0)
        yield* Effect.andThen(indexer.indexAll(), indexer.analyzeAll()).pipe(
          Effect.catchCause(() => Effect.void),
        );
      return changedNodes;
    }).pipe(onePassAtATime.withPermits(1));

    if (running) yield* Effect.forkScoped(Effect.catchCause(run, () => Effect.void));

    return {
      run,
      progress: (): SweepProgress[] =>
        targets.map((target) => {
          const saved = progressOf(target);
          return { target: targetName(target), done: saved.done === 1, hidden: saved.hidden };
        }),
    };
  });

/**
 * Hides secrets in stored text that was not hidden on the way in: nodes (and the search index,
 * morpheme terms and vectors made from them), references, the saved conversation, approvals,
 * queued messages and subagent records. Runs in the background on every start.
 */
export class SecretSweep extends Context.Service<
  SecretSweep,
  Effect.Success<ReturnType<typeof make>>
>()("memory-agent/SecretSweep") {
  static readonly layer = (running: boolean = true) => Layer.effect(SecretSweep, make(running));
}
